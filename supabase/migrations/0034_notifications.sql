-- Busihub — 0034: notifications (Phase 15)
--
-- Scoped deliberately to in-app only, after asking rather than assuming:
-- SMS and email both need a third-party account (a Ghana SMS gateway, an
-- email provider) that is a real business/cost decision for the shop
-- owner, not something this migration can provision. This ships the
-- in-app bell — a notifications table, a live-computed feed, per-user
-- read tracking — and four kinds of alert. SMS/email are a layered-on
-- follow-up once those accounts exist.
--
-- ── The one decision worth explaining before the schema: two kinds of
-- alert, not one ─────────────────────────────────────────────────────────
--
-- "Low stock" and "customer over their credit limit" are STATES: true
-- right now, false once the shelf is restocked or the balance is paid
-- down, with no natural "this happened at 3:41pm" moment. "A refund was
-- processed" and "a sale was voided" are EVENTS: something happened once,
-- at a specific time, and stays true forever afterwards.
--
-- Storing a state as a row is exactly the kind of derived truth this
-- codebase has spent nine phases refusing to trust (`stock_levels`,
-- `customer_balances`, `dashboard_snapshot()` — all computed fresh, never
-- cached as fact). A persisted "low stock" notification would either go
-- stale (still shown after the shop restocks, because nothing deleted
-- it) or duplicate (a new row every time someone happens to trigger a
-- re-check while it is still true) — both are a false status displayed
-- as current, which is the one thing a shopkeeper cannot safely
-- second-guess on an alert screen.
--
-- So: EVENT-type alerts (refund_created, sale_voided) are real rows in
-- `notifications`, written once, by the same function that performed the
-- action (void_sale(), create_refund() below) — never re-derived, exactly
-- like every other financial record in this database. STATE-type alerts
-- (low_stock, credit_limit, stuck_payment) are never stored at all —
-- `notification_feed_base()` computes them fresh from the same tables the
-- dashboard already trusts (`low_stock_report()`, `customer_balances`,
-- `sales`), every time the feed is read. A restocked product simply stops
-- appearing; there is no row to clean up because there was never a row.
--
-- Read/dismissed state for BOTH kinds shares one small table,
-- `notification_dismissals`, keyed by a stable text key rather than a
-- foreign key to `notifications.id` — because a state-type alert has no
-- row to point at. 'event:<notifications.id>' for a real event,
-- 'low_stock:<variant_id>:<branch_id>' / 'credit_limit:<customer_id>' /
-- 'stuck_payment:<sale_id>' for a computed one. Marking a low-stock alert
-- read suppresses it for that person until the underlying state changes
-- shape (restocked then low again looks the same key, which is an
-- accepted simplification for v1 — see the header on
-- notification_feed_base() below).
--
-- ── Who sees what: no new permission, on purpose ─────────────────────────
--
-- Visibility is entirely inherited from permissions that already exist.
-- low_stock reads through `low_stock_report()`, which itself reads
-- `stock_levels`, whose own RLS already requires inventory.view — a
-- second permission check here would just be restating that policy and
-- risking it drifting from it. credit_limit reads `customer_balances`,
-- gated the same way by customers.view. stuck_payment reads `sales`,
-- gated by sales.process or reports.view exactly as the sales list page
-- already is. Only the persisted `notifications` table needs its own
-- policy, since nothing else's RLS already covers it: reports.view (the
-- same "money-adjacent visibility" bar the dashboard and P&L use),
-- sales.void or sales.refund (whoever is trusted to perform the action is
-- trusted to see the log of it).
--
-- ── What this deliberately does NOT build ────────────────────────────────
--
-- No Supabase Realtime subscription. The architecture doc's original
-- system diagram names Realtime as the eventual mechanism, and it may
-- still be the right one — but this sandbox has no live Supabase project
-- to prove an `alter publication supabase_realtime add table
-- notifications` statement actually delivers an event against your real
-- project, and shipping unverified plumbing is exactly what "do not fake
-- completion" rules out. The bell polls instead (every 45s from the
-- client) — slower, but the whole path from RLS to render is something
-- this migration's own tests can actually prove works. Wiring Realtime on
-- top, once you can confirm it fires against the live project, is a small
-- follow-up, not a redesign.
--
-- No purchase-order or PIN-lockout alerts. You picked four events for
-- this pass (low stock, credit limit, refund/void, stuck payment); the
-- others discussed can follow the same two patterns established here.

-- ── notifications: persisted, EVENT-type alerts only ─────────────────────

create table notifications (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id) on delete cascade,
  -- Null is possible in principle for a business-wide event type; every
  -- type actually defined below always sets it (both come from a sale).
  branch_id      uuid references branches(id) on delete set null,
  type           text not null check (type in ('refund_created', 'sale_voided')),
  severity       text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  reference_type text not null,
  reference_id   uuid not null,
  -- Who was signed in when it happened — auth.uid(), never a
  -- client-supplied id, enforced by the WITH CHECK below. The
  -- till-identified cashier (who may differ on a shared device) travels
  -- in `data` instead, for display only.
  actor_user_id  uuid references profiles(id) on delete set null,
  -- Type-specific display fields (receipt_number, refund_number, total,
  -- reason, cashier name/id). Deliberately NOT a pre-formatted sentence:
  -- baking "GHS 45.00" into a stored string would hardcode this
  -- business's currency into every future row, and this database already
  -- stores currency per-business for exactly this reason (Section:
  -- Money). lib/notifications/format.ts composes the sentence client-side
  -- from these raw values, the same separation receipts already use.
  data           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index notifications_business_created_idx on notifications (business_id, created_at desc);
create index notifications_reference_idx on notifications (reference_type, reference_id);

comment on table notifications is
  'Persisted, append-only log of EVENT-type notifications only (something that happened once, at a specific time — currently refund_created and sale_voided). STATE-type alerts (low stock, credit limit, stuck payment) are never stored here; see notification_feed_base() below for why. Written only by void_sale()/create_refund(), which run as the caller — so the INSERT policy below is the real gate, not a formality.';

alter table notifications enable row level security;

create policy notifications_select on notifications
  for select
  using (
    app_has_permission(business_id, 'reports.view')
    or app_has_permission(business_id, 'sales.void')
    or app_has_permission(business_id, 'sales.refund')
    or app_is_super_admin()
  );

-- void_sale()/create_refund() run as the caller (not SECURITY DEFINER),
-- so this INSERT policy is what actually lets the notification through —
-- and it is written narrowly enough that even a direct PostgREST insert,
-- bypassing both functions entirely, cannot do anything worse than a
-- truthful, low-value nuisance: business_id is forced to the caller's own
-- (never trusted from the client), actor_user_id must be the caller
-- themselves (nobody can attribute an event to a colleague), the
-- reference must be a real sale in that same business, and the type must
-- match a permission the caller actually holds — so a Cashier holding
-- neither sales.void nor sales.refund cannot manufacture either kind of
-- alert about anyone, including themselves.
create policy notifications_insert on notifications
  for insert
  with check (
    business_id = app_current_business_id()
    and actor_user_id = (select auth.uid())
    and reference_type = 'sale'
    and exists (
      select 1 from sales s where s.id = reference_id and s.business_id = business_id
    )
    and (
      (type = 'sale_voided' and app_has_permission(business_id, 'sales.void'))
      or (type = 'refund_created' and app_has_permission(business_id, 'sales.refund'))
      or app_is_super_admin()
    )
  );

-- No UPDATE/DELETE policy, and the grants revoked outright — an event
-- notification is exactly as immutable as the sale/refund it describes.
revoke update, delete on notifications from authenticated;

-- ── notification_dismissals: per-user read state, for both kinds ────────

create table notification_dismissals (
  user_id       uuid not null references profiles(id) on delete cascade,
  business_id   uuid not null references businesses(id) on delete cascade,
  dismissal_key text not null check (char_length(dismissal_key) between 1 and 200),
  dismissed_at  timestamptz not null default now(),
  primary key (user_id, dismissal_key)
);

create index notification_dismissals_business_idx on notification_dismissals (business_id);

comment on table notification_dismissals is
  'Marks one notification (event or computed state) read, for one user. Keyed by a stable text key rather than a foreign key to notifications.id, because a STATE-type alert (low stock, credit limit, stuck payment) has no row to point at — see 0034''s header. Not meant to be written directly; mark_notification_read()/mark_all_notifications_read() below fill in user_id/business_id from the session so neither can be spoofed, the same reasoning as every other never-trust-the-client id in this schema.';

alter table notification_dismissals enable row level security;

create policy notification_dismissals_select on notification_dismissals
  for select
  using (user_id = (select auth.uid()));

create policy notification_dismissals_insert on notification_dismissals
  for insert
  with check (user_id = (select auth.uid()) and business_id = app_current_business_id());

create policy notification_dismissals_delete on notification_dismissals
  for delete
  using (user_id = (select auth.uid()));

-- No UPDATE policy is defined, which is what actually keeps a raw
-- PostgREST PATCH out — the same "table grant exists, RLS still refuses
-- it" reasoning 0009 documents for audit_logs. The table-level UPDATE
-- grant is deliberately left in place (not revoked) because
-- mark_notification_read()'s `on conflict ... do update` needs it: an
-- INSERT statement with an ON CONFLICT DO UPDATE clause is permission
-- checked as if the UPDATE might run, even on a call where it never
-- does, so revoking UPDATE here would break re-marking an
-- already-dismissed notification read, not merely lock out a nonexistent
-- attack surface.

-- ── notification_feed_base(): the one place both kinds are combined ─────
--
-- SECURITY INVOKER (the default — no keyword needed, called out
-- explicitly here because it is the entire safety argument): RLS on
-- `notifications`, `stock_levels`, `customer_balances` and `sales` does
-- the real filtering. This function adds no privilege of its own: a
-- caller who cannot see a row through the underlying table cannot see it
-- through this function either. Nothing here is SECURITY DEFINER, and
-- tests/security/notifications.sql asserts that directly, the same way
-- the reporting functions are checked (0030).
--
-- low_stock is composed from low_stock_report() (0030) rather than
-- re-deriving "what counts as low" a second time — two definitions of low
-- stock is two definitions that eventually disagree, which is the exact
-- bug Phase 14's P&L went out of its way to avoid for "net sales".
--
-- occurred_at for a STATE alert is a proxy, not an event time, because a
-- state has no "when it happened": low_stock uses stock_levels.updated_at
-- (when the level last changed), credit_limit uses
-- customer_balances.updated_at (when the balance last moved),
-- stuck_payment uses the sale's own created_at (when it started waiting).
-- All three are honest about being "as of", not "this occurred at".
create or replace function notification_feed_base()
returns table (
  dismissal_key  text,
  type           text,
  severity       text,
  reference_type text,
  reference_id   uuid,
  branch_id      uuid,
  occurred_at    timestamptz,
  data           jsonb,
  is_read        boolean
)
language sql
stable
as $$
  with events as (
    select
      'event:' || n.id::text as dismissal_key,
      n.type,
      n.severity,
      n.reference_type,
      n.reference_id,
      n.branch_id,
      n.created_at as occurred_at,
      n.data
    from notifications n
    -- Bounded so this never scales with total history the way an
    -- unfiltered date-range query over an RLS-protected table can (see
    -- 0033's header) — at 30 days of refund/void volume for one shop this
    -- is dozens of rows, nowhere near where that limitation would bite.
    where n.created_at > now() - interval '30 days'
  ),
  low_stock as (
    select
      'low_stock:' || lsr.variant_id::text || ':' || lsr.branch_id::text,
      'low_stock',
      case lsr.severity when 'low' then 'warning' else 'critical' end,
      'product_variant',
      lsr.variant_id,
      lsr.branch_id,
      coalesce(
        (select sl.updated_at from stock_levels sl
         where sl.variant_id = lsr.variant_id and sl.branch_id = lsr.branch_id),
        now()
      ),
      jsonb_build_object(
        'product_name', lsr.product_name,
        'sku', lsr.sku,
        'branch_name', lsr.branch_name,
        'quantity', lsr.quantity,
        'reorder_point', lsr.reorder_point,
        'stock_severity', lsr.severity
      )
    from low_stock_report(null, 200) lsr
    -- Respects business_settings.notification_settings.low_stock_alerts
    -- (seeded '{"low_stock_alerts": true, ...}' since 0002) so a shop that
    -- has switched this off does not have it silently reappear here.
    -- Relies on RLS on business_settings the same way low_stock_report()
    -- itself already relies on it for the threshold fallback — `limit 1`
    -- is safe because RLS admits at most this business's own row.
    where coalesce((select (bs.notification_settings ->> 'low_stock_alerts')::boolean from business_settings bs limit 1), true)
  ),
  credit as (
    select
      'credit_limit:' || cb.customer_id::text,
      'credit_limit',
      'warning',
      'customer',
      cb.customer_id,
      null::uuid,
      coalesce(cb.updated_at, now()),
      jsonb_build_object(
        'customer_name', c.name,
        'balance', cb.balance,
        'credit_limit', c.credit_limit
      )
    from customer_balances cb
    join customers c on c.id = cb.customer_id
    where c.credit_limit > 0 and cb.balance >= c.credit_limit and c.status = 'active'
  ),
  stuck as (
    select
      'stuck_payment:' || s.id::text,
      'stuck_payment',
      'warning',
      'sale',
      s.id,
      s.branch_id,
      s.created_at,
      jsonb_build_object(
        'receipt_number', s.receipt_number,
        'created_at', s.created_at
      )
    from sales s
    -- 15 minutes: the payments phase (0022/0024) notes a momo webhook
    -- "normally settles within a second or two" — long enough that
    -- anything still waiting this long is worth a look, short enough that
    -- it does not fire on every ordinary prompt.
    where s.status = 'awaiting_payment'
      and s.created_at < now() - interval '15 minutes'
  ),
  combined as (
    select * from events
    union all select * from low_stock
    union all select * from credit
    union all select * from stuck
  )
  select
    c.dismissal_key, c.type, c.severity, c.reference_type, c.reference_id,
    c.branch_id, c.occurred_at, c.data,
    exists (
      select 1 from notification_dismissals nd
      where nd.user_id = (select auth.uid()) and nd.dismissal_key = c.dismissal_key
    ) as is_read
  from combined c;
$$;

grant execute on function notification_feed_base() to authenticated;

comment on function notification_feed_base() is
  'Unions persisted EVENT rows with freshly-computed STATE alerts (low stock, credit limit, stuck payment) and marks each read/unread for the calling user. SECURITY INVOKER — every row returned already passed the underlying table''s own RLS, so this grants no visibility of its own. Not meant to be called directly by the app; see notification_feed() for the paginated/filterable wrapper.';

-- ── notification_feed(): what the app actually calls ─────────────────────

create or replace function notification_feed(
  p_branch_id uuid default null,
  p_limit int default 50
)
returns table (
  dismissal_key  text,
  type           text,
  severity       text,
  reference_type text,
  reference_id   uuid,
  branch_id      uuid,
  occurred_at    timestamptz,
  data           jsonb,
  is_read        boolean
)
language sql
stable
as $$
  select f.*
  from notification_feed_base() f
  where p_branch_id is null or f.branch_id is null or f.branch_id = p_branch_id
  order by f.is_read asc, f.occurred_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

grant execute on function notification_feed(uuid, int) to authenticated;

comment on function notification_feed(uuid, int) is
  'Unread first, then newest first, capped at 200. A branch filter matches branch-scoped rows exactly and always includes business-wide ones (credit_limit) rather than hiding them under an unrelated branch filter.';

-- ── mark_notification_read() / mark_all_notifications_read() ────────────
--
-- RPC wrappers rather than exposing notification_dismissals to direct
-- PostgREST writes: user_id and business_id are filled in here from the
-- session, so the client never sends either — one less id for a caller to
-- get "wrong" (Section 49's never-trust-client-ids list, applied to a
-- table that is low-stakes but no less in scope for it).

create or replace function mark_notification_read(p_dismissal_key text)
returns void
language plpgsql
as $$
begin
  if p_dismissal_key is null or char_length(trim(p_dismissal_key)) = 0 then
    raise exception 'Missing notification' using errcode = 'P0001';
  end if;

  insert into notification_dismissals (user_id, business_id, dismissal_key)
  values ((select auth.uid()), app_current_business_id(), p_dismissal_key)
  on conflict (user_id, dismissal_key) do update set dismissed_at = now();
end;
$$;

grant execute on function mark_notification_read(text) to authenticated;

create or replace function mark_notification_unread(p_dismissal_key text)
returns void
language sql
as $$
  delete from notification_dismissals
  where user_id = (select auth.uid()) and dismissal_key = p_dismissal_key;
$$;

grant execute on function mark_notification_unread(text) to authenticated;

create or replace function mark_all_notifications_read()
returns void
language plpgsql
as $$
declare
  v_business_id uuid := app_current_business_id();
begin
  insert into notification_dismissals (user_id, business_id, dismissal_key)
  select (select auth.uid()), v_business_id, f.dismissal_key
  from notification_feed_base() f
  where not f.is_read
  on conflict (user_id, dismissal_key) do nothing;
end;
$$;

grant execute on function mark_all_notifications_read() to authenticated;

-- ── void_sale(): now writes its own event notification ───────────────────
--
-- Re-declared here, unchanged except for the notification insert added
-- right before the success check at the end. Writing it inside the same
-- function that performs the void (rather than an AFTER UPDATE trigger on
-- `sales`) is deliberate: p_reason is a plain argument in scope here, and
-- is NOT a column on `sales` — it only ever reaches
-- inventory_movements.note as free text (0021), which a trigger reading
-- NEW would have no way to recover. Computing the notification where the
-- reason already lives, once, is the same "compute once, at the point of
-- truth" reasoning the rest of this function already follows.
create or replace function void_sale(p_sale_id uuid, p_reason text default null)
returns void
language plpgsql
as $$
declare
  v_sale sales%rowtype;
  v_item sale_items%rowtype;
  v_rows int;
begin
  perform pg_advisory_xact_lock(hashtextextended('sale_correction:' || p_sale_id::text, 0));

  select * into v_sale from sales where id = p_sale_id;

  if v_sale.id is null then
    raise exception 'Sale not found' using errcode = 'P0002';
  end if;

  if not (app_has_permission(v_sale.business_id, 'sales.void') or app_is_super_admin()) then
    raise exception 'Missing permission: sales.void' using errcode = '42501';
  end if;

  if v_sale.status <> 'completed' then
    raise exception '%', case v_sale.status
      when 'voided' then 'This sale has already been voided'
      when 'awaiting_payment' then 'This sale is still waiting for payment — cancel it instead'
      when 'cancelled' then 'This sale was cancelled before it was paid for'
      else 'This sale cannot be voided'
    end using errcode = 'P0001';
  end if;

  if exists (select 1 from refunds where sale_id = p_sale_id) then
    raise exception 'This sale has been refunded and cannot be voided. Refund the rest instead.'
      using errcode = 'P0001';
  end if;

  for v_item in select * from sale_items where sale_id = p_sale_id
  loop
    insert into inventory_movements (
      business_id, branch_id, variant_id, quantity_delta, reason,
      reference_type, reference_id, note
    )
    values (
      '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
      v_sale.branch_id, v_item.variant_id, v_item.quantity, 'sale_refund',
      'sale_void', p_sale_id,
      'Void of ' || v_sale.receipt_number || coalesce(' — ' || nullif(p_reason, ''), '')
    );
  end loop;

  if v_sale.payment_method = 'credit' and v_sale.customer_id is not null then
    insert into customer_account_entries (
      business_id, customer_id, branch_id, amount, entry_type, reference_type, reference_id, note
    )
    values (
      '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
      v_sale.customer_id, v_sale.branch_id, -v_sale.total, 'refund',
      'sale_void', p_sale_id,
      'Void of ' || v_sale.receipt_number
    );
  end if;

  update sales set status = 'voided' where id = p_sale_id;

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'Could not void this sale' using errcode = '42501';
  end if;

  -- The notification insert's own WITH CHECK re-derives business_id from
  -- app_current_business_id() and requires sales.void — both already
  -- true, since we could not have reached here otherwise — so this can
  -- only fail if the two ever drift, which is exactly what
  -- tests/security/notifications.sql's sabotage cases are for.
  insert into notifications (business_id, branch_id, type, severity, reference_type, reference_id, actor_user_id, data)
  values (
    v_sale.business_id, v_sale.branch_id, 'sale_voided', 'warning', 'sale', p_sale_id, (select auth.uid()),
    jsonb_build_object(
      'receipt_number', v_sale.receipt_number,
      'total', v_sale.total,
      'reason', nullif(p_reason, ''),
      'cashier_id', v_sale.cashier_id
    )
  );
end;
$$;

grant execute on function void_sale(uuid, text) to authenticated;

comment on function void_sale(uuid, text) is
  'Cancels a whole sale: every item back to stock, any account charge reversed, status set to voided, and a sale_voided notification recorded — in one transaction. Refused if the sale has already been partly refunded, since that would double the reversal.';

-- ── create_refund(): now writes its own event notification ──────────────
--
-- Re-declared here (matching 0029's signature, the current live one — NOT
-- 0021's original), unchanged except for the notification insert added
-- right before the return.
create or replace function create_refund(
  p_sale_id uuid,
  p_cashier_id uuid,
  p_method text,
  p_reason text,
  p_items jsonb -- [{sale_item_id, quantity, restock}]
)
returns uuid
language plpgsql
as $$
declare
  v_sale        sales%rowtype;
  v_item        jsonb;
  v_line        sale_items%rowtype;
  v_qty         numeric(14, 3);
  v_already     numeric(14, 3);
  v_restock     boolean;
  v_refund_id   uuid;
  v_next        int;
  v_reference   text;
  v_line_total  numeric(14, 2);
  v_line_tax    numeric(14, 2);
  v_line_sub    numeric(14, 2);
  v_subtotal    numeric(14, 2) := 0;
  v_tax_total   numeric(14, 2) := 0;
  v_total       numeric(14, 2) := 0;
  v_lines       jsonb := '[]'::jsonb;
begin
  if p_items is null or jsonb_array_length(p_items) < 1 then
    raise exception 'Choose what is being returned' using errcode = 'P0001';
  end if;

  if p_method not in ('cash', 'credit') then
    raise exception 'Unknown refund method' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sale_correction:' || p_sale_id::text, 0));

  select * into v_sale from sales where id = p_sale_id;

  if v_sale.id is null then
    raise exception 'Sale not found' using errcode = 'P0002';
  end if;
  if v_sale.status <> 'completed' then
    raise exception '%', case v_sale.status
      when 'voided' then 'This sale was voided; there is nothing to refund'
      when 'awaiting_payment' then 'This sale has not been paid for yet, so there is nothing to give back'
      when 'cancelled' then 'This sale was cancelled before it was paid for'
      else 'This sale cannot be refunded'
    end using errcode = 'P0001';
  end if;

  if p_method = 'credit' and v_sale.customer_id is null then
    raise exception 'This was a walk-in sale, so it can only be refunded in cash' using errcode = 'P0001';
  end if;

  if p_cashier_id is not null then
    if not exists (
      select 1 from profiles
      where id = p_cashier_id and business_id = v_sale.business_id and status = 'active'
    ) then
      raise exception 'Invalid cashier' using errcode = 'P0002';
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      continue;
    end if;

    select * into v_line from sale_items
    where id = (v_item ->> 'sale_item_id')::uuid and sale_id = p_sale_id;

    if v_line.id is null then
      raise exception 'That line is not part of this sale' using errcode = 'P0002';
    end if;

    v_already := sale_item_refunded_quantity(v_line.id);
    if v_qty + v_already > v_line.quantity then
      raise exception 'Only % of "%" is left to refund', v_line.quantity - v_already, v_line.description
        using errcode = 'P0001';
    end if;

    v_line_total := round(v_line.line_total * v_qty / v_line.quantity, 2);
    v_line_tax   := round(v_line.line_tax * v_qty / v_line.quantity, 2);
    v_line_sub   := v_line_total - v_line_tax;

    v_restock := coalesce((v_item ->> 'restock')::boolean, true);

    v_lines := v_lines || jsonb_build_object(
      'sale_item_id', v_line.id,
      'variant_id', v_line.variant_id,
      'quantity', v_qty,
      'unit_price', v_line.unit_price,
      'unit_cost', coalesce(v_line.unit_cost, 0),
      'line_subtotal', v_line_sub,
      'line_tax', v_line_tax,
      'line_total', v_line_total,
      'restock', v_restock
    );

    v_subtotal  := v_subtotal + v_line_sub;
    v_tax_total := v_tax_total + v_line_tax;
    v_total     := v_total + v_line_total;
  end loop;

  if jsonb_array_length(v_lines) = 0 then
    raise exception 'Choose what is being returned' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('refund:' || v_sale.business_id::text, 0));

  select coalesce(max((substring(refund_number from '^RF-([0-9]+)$'))::int), 0) + 1
  into v_next
  from refunds
  where business_id = v_sale.business_id and refund_number ~ '^RF-[0-9]+$';

  v_reference := 'RF-' || lpad(v_next::text, 6, '0');

  insert into refunds (
    business_id, sale_id, refund_number, method, reason,
    subtotal, tax_total, total, cashier_id, created_by
  )
  values (
    v_sale.business_id, p_sale_id, v_reference, p_method, nullif(p_reason, ''),
    v_subtotal, v_tax_total, v_total, p_cashier_id, auth.uid()
  )
  returning id into v_refund_id;

  for v_item in select * from jsonb_array_elements(v_lines)
  loop
    insert into refund_items (
      refund_id, business_id, sale_item_id, variant_id, quantity,
      unit_price, unit_cost, line_subtotal, line_tax, line_total, restocked
    )
    values (
      v_refund_id, v_sale.business_id, (v_item ->> 'sale_item_id')::uuid,
      (v_item ->> 'variant_id')::uuid, (v_item ->> 'quantity')::numeric,
      (v_item ->> 'unit_price')::numeric, (v_item ->> 'unit_cost')::numeric,
      (v_item ->> 'line_subtotal')::numeric,
      (v_item ->> 'line_tax')::numeric, (v_item ->> 'line_total')::numeric,
      (v_item ->> 'restock')::boolean
    );

    if (v_item ->> 'restock')::boolean then
      insert into inventory_movements (
        business_id, branch_id, variant_id, quantity_delta, reason,
        reference_type, reference_id, note
      )
      values (
        '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
        v_sale.branch_id, (v_item ->> 'variant_id')::uuid, (v_item ->> 'quantity')::numeric,
        'sale_refund', 'refund', v_refund_id,
        'Returned on ' || v_reference
      );
    end if;
  end loop;

  if p_method = 'credit' and v_total > 0 then
    insert into customer_account_entries (
      business_id, customer_id, branch_id, amount, entry_type, reference_type, reference_id, note
    )
    values (
      '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
      v_sale.customer_id, v_sale.branch_id, -v_total, 'refund', 'refund', v_refund_id,
      'Refund ' || v_reference
    );
  end if;

  insert into notifications (business_id, branch_id, type, severity, reference_type, reference_id, actor_user_id, data)
  values (
    v_sale.business_id, v_sale.branch_id, 'refund_created', 'warning', 'sale', p_sale_id, (select auth.uid()),
    jsonb_build_object(
      'receipt_number', v_sale.receipt_number,
      'refund_number', v_reference,
      'total', v_total,
      'reason', nullif(p_reason, ''),
      'cashier_id', p_cashier_id
    )
  );

  return v_refund_id;
end;
$$;

grant execute on function create_refund(uuid, uuid, text, text, jsonb) to authenticated;

comment on function create_refund(uuid, uuid, text, text, jsonb) is
  'Takes specific sale lines back: refund/refund_items rows, stock restored unless damaged, an account credit if paid on credit, and a refund_created notification — in one transaction. Money is apportioned from the original sale line, never recomputed from today''s prices.';