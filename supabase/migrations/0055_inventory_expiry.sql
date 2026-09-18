-- Busihub — 0055: inventory expiry dates
--
-- business_settings.inventory_settings has carried a track_expiry flag
-- since the very first schema (0002), and Settings → Business has had a
-- "Track expiry dates" checkbox wired to it since early on too — but
-- nothing anywhere ever read that flag or recorded an actual expiry date.
-- This migration is what makes the toggle real.
--
-- ── Scope, decided up front ──────────────────────────────────────────────
--
-- inventory_settings ALSO has a separate track_batches flag, which this
-- migration deliberately does NOT touch. "Batches/lots" implies full
-- FIFO tracking — knowing exactly how many units of *this specific*
-- delivery remain as they sell, transfer, get refunded, and get counted —
-- which would mean wiring batch consumption into every stock-decreasing
-- path in the app (till completion, refunds, transfers, stock counts).
-- That's a much larger, higher-risk change to code this business
-- actually depends on every day, and it's a separate toggle the user did
-- not ask to turn on.
--
-- What this migration builds instead is honestly scoped to what
-- "expiry dates" needs on its own: stock_batches is an append-only
-- record of "this quantity, received/logged on this date, expires on
-- this date" — informational, and never the source of truth for how
-- much is on hand (stock_levels, unchanged, still is). It does NOT claim
-- to know how much of a given batch is still unsold. Every surface this
-- migration adds (the alert, the item page, the list badge) is worded
-- accordingly: "X on hand, soonest recorded expiry is Y" — two true
-- facts shown together, never "Y units expire on Y".
--
-- ── stock_batches ─────────────────────────────────────────────────────────

create table stock_batches (
  id          uuid primary key default gen_random_uuid(),
  -- Denormalized from the branch, same as inventory_movements.business_id
  -- (0015) and for the same reason: RLS scopes this table directly.
  business_id uuid not null references businesses(id) on delete cascade,
  branch_id   uuid not null references branches(id) on delete cascade,
  variant_id  uuid not null references product_variants(id) on delete cascade,
  quantity    numeric(14, 3) not null check (quantity > 0),
  expiry_date date not null,
  note        text,
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index stock_batches_business_id_idx on stock_batches (business_id);
create index stock_batches_variant_branch_idx on stock_batches (variant_id, branch_id);
create index stock_batches_expiry_date_idx on stock_batches (expiry_date);

comment on table stock_batches is
  'Informational record of a quantity logged with an expiry date — NOT a live remaining-quantity ledger (that would require wiring batch consumption into sales/refunds/transfers/counts, deliberately out of scope here; see this migration''s header). stock_levels remains the sole source of truth for what''s on hand. Insert/delete only, no update — correcting a mistake is delete-and-re-add, same philosophy as inventory_movements being append-only.';

-- set_inventory_movement_context() (0015) is reused as-is rather than
-- duplicated: it only ever reads NEW.branch_id/NEW.variant_id and writes
-- NEW.business_id/NEW.created_by, all of which stock_batches has under
-- the same names, so the exact same tenant-forcing + branch/variant
-- business-match logic applies unchanged.
create trigger set_batch_context
  before insert on stock_batches
  for each row execute function set_inventory_movement_context();

alter table stock_batches enable row level security;

create policy stock_batches_select on stock_batches
  for select
  using (app_has_permission(business_id, 'inventory.view') or app_is_super_admin());

create policy stock_batches_insert on stock_batches
  for insert
  with check (app_has_permission(business_id, 'inventory.receive') or app_is_super_admin());

create policy stock_batches_delete on stock_batches
  for delete
  using (app_has_permission(business_id, 'inventory.adjust') or app_is_super_admin());

-- No update policy or grant: see the table comment above.
revoke update on stock_batches from authenticated;

-- ── expiring_stock_report(): one row per (variant, branch), soonest
-- recorded expiry first — same shape and same reasoning as
-- low_stock_report() (0030): one definition of "expiring soon", reused
-- everywhere instead of re-derived per screen.
--
-- Only variant/branch pairs that currently have stock on hand are
-- returned (sl.quantity > 0) — an honest floor given stock_batches
-- doesn't know how much of a specific batch remains: at minimum, this
-- guarantees the alert isn't raised for something already fully sold
-- through, which is the one case that would be actively misleading.

create or replace function expiring_stock_report(
  p_branch_id uuid default null,
  p_within_days int default 7,
  p_limit int default 20
)
returns table (
  variant_id uuid,
  branch_id uuid,
  branch_name text,
  product_name text,
  sku text,
  quantity_on_hand numeric,
  expiry_date date,
  days_until_expiry int,
  batch_created_at timestamptz,
  severity text
)
language sql
stable
as $$
  with soonest as (
    select distinct on (sb.variant_id, sb.branch_id)
      sb.variant_id, sb.branch_id, sb.expiry_date, sb.created_at
    from stock_batches sb
    order by sb.variant_id, sb.branch_id, sb.expiry_date asc, sb.created_at asc
  )
  select
    s.variant_id, s.branch_id, b.name, p.name, v.sku,
    sl.quantity, s.expiry_date, (s.expiry_date - current_date)::int, s.created_at,
    case when s.expiry_date < current_date then 'critical' else 'warning' end
  from soonest s
  join stock_levels sl on sl.variant_id = s.variant_id and sl.branch_id = s.branch_id
  join product_variants v on v.id = s.variant_id
  join products p on p.id = v.product_id
  join branches b on b.id = s.branch_id
  where v.status = 'active'
    and p.status = 'active'
    and sl.quantity > 0
    and (p_branch_id is null or s.branch_id = p_branch_id)
    and s.expiry_date <= current_date + coalesce(p_within_days, 7)
  order by s.expiry_date asc, p.name
  limit least(greatest(coalesce(p_limit, 20), 1), 200);
$$;

grant execute on function expiring_stock_report(uuid, int, int) to authenticated;

comment on function expiring_stock_report(uuid, int, int) is
  'Stock on hand whose soonest recorded batch expiry falls within p_within_days (or has already passed). One row per variant/branch, same "collapse to the worst case" shape as low_stock_report(). Runs as the caller — relies entirely on RLS on stock_batches/stock_levels, same as low_stock_report().';

-- ── wire into the existing notification feed (0034) ──────────────────────
--
-- A new STATE-type alert, same reasoning 0034's header gives for
-- low_stock/credit_limit/stuck_payment: "expiring soon" is true right
-- now and false once restocked/sold through/the date passes with nothing
-- left — not an event with a "this happened at 3:41pm" moment. Computed
-- fresh from expiring_stock_report() every read, never persisted.
--
-- Gated on inventory_settings.track_expiry (not a new, separate
-- notification-settings flag) — the one toggle this feature already
-- exposes in Settings → Business. A business that has never turned it on,
-- or has turned it back off, should not see alerts derived from stray old
-- batch rows.
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
  expiring_stock as (
    select
      'expiring_stock:' || esr.variant_id::text || ':' || esr.branch_id::text,
      'expiring_stock',
      esr.severity,
      'product_variant',
      esr.variant_id,
      esr.branch_id,
      esr.batch_created_at,
      jsonb_build_object(
        'product_name', esr.product_name,
        'sku', esr.sku,
        'branch_name', esr.branch_name,
        'quantity', esr.quantity_on_hand,
        'expiry_date', esr.expiry_date,
        'days_until_expiry', esr.days_until_expiry
      )
    from expiring_stock_report(null, 7, 200) esr
    where coalesce((select (bs.inventory_settings ->> 'track_expiry')::boolean from business_settings bs limit 1), false)
  ),
  combined as (
    select * from events
    union all select * from low_stock
    union all select * from credit
    union all select * from stuck
    union all select * from expiring_stock
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