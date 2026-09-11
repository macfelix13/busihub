-- Busihub — 0052: offline sync, backend half (Phase 17)
--
-- Scoped deliberately to the server side only. The client half — the
-- IndexedDB product cache and sale outbox, the till's offline UI
-- restrictions, and the service worker's background sync — is separate
-- follow-up work; nothing here depends on it existing yet, and nothing
-- here is reachable by an ordinary till sale until that client half
-- calls app/api/sync/route.ts with a client_transaction_id. Every
-- existing call to create_sale() (the till today) is unaffected: the new
-- parameter defaults to null, and every new code path below is gated on
-- it being set.
--
-- This migration was anticipated, almost word for word, by a comment
-- already sitting in 0020_sales.sql: "Phase 17 (offline sync) will need
-- the same escape hatch for a different reason: a sale that already
-- happened in the shop cannot be refused retroactively, so synced sales
-- are specified to land and be flagged." That is exactly what this does
-- — reusing 0020's own allow_negative_stock escape hatch's shape for a
-- new, always-on reason, rather than inventing a parallel mechanism.
--
-- ── the shape of it ───────────────────────────────────────────────────
--
-- create_sale() gets one new, optional, trailing parameter —
-- p_client_transaction_id — following the exact precedent 0022 set
-- (p_payments was added the same way: CREATE OR REPLACE, no DROP, old
-- callers unaffected). Set ONLY by the sync endpoint, never by the
-- ordinary till UI:
--
--   * Idempotent replay: if a sale with this (business_id,
--     client_transaction_id) already exists, its id is returned
--     immediately — no re-pricing, no second stock movement, no second
--     payment row. A flaky connection retrying the same POST is a
--     no-op, not a duplicate sale. The lookup is scoped by the caller's
--     own RLS on `sales` (sales_select, 0037) rather than bypassing it —
--     the only caller who would ever legitimately retry a given id is
--     the same signed-in session that generated it offline, and that
--     session can always see its own sales. The unique index below is
--     the real backstop if this lookup ever misses for some other
--     reason: a genuine duplicate insert fails loudly instead of
--     landing twice.
--   * Mobile money refused: a momo charge needs a live prompt to a
--     phone right now — there is no "prompt them later" version of
--     that. Cash and on-account are the only tenders a synced sale may
--     carry, exactly as the architecture doc's Section 7 specifies.
--     Enforced here, not just in the route handler that will call this
--     — neither layer is trusted alone.
--   * Stock allowed to go negative, unconditionally: a `sale_synced`
--     inventory_movements row (new reason, alongside the existing
--     `sale`/`sale_refund`/`sale_cancelled`) tells the trigger below to
--     land the movement regardless of the business's own
--     allow_negative_stock setting — that setting is about a shop's
--     ordinary risk tolerance for overselling in real time, which has
--     nothing to do with a sale that provably already happened in the
--     shop before this device reconnected. The trigger records the
--     resulting shortfall as a notification instead of silently
--     absorbing it, so the shop finds out rather than discovering it at
--     the next stock count.
--
-- Deliberately NOT touched: the existing allow_negative_stock path for
-- an ordinary online sale (reason = 'sale') does not gain a notification
-- here — that was a pre-existing, already-shipped 0020 decision, and
-- extending it is a separate call this migration doesn't make.

-- ── sales: the idempotency key itself ────────────────────────────────────

alter table sales add column client_transaction_id uuid;

comment on column sales.client_transaction_id is
  'Set only for a sale created via the offline-sync endpoint (0052) — the client-generated UUID an offline till assigned when the sale actually happened, before this device could reach the server. Null for every ordinary online sale. Unique per business (see the index below), which is what makes a retried sync request a no-op rather than a duplicate.';

-- Partial: only synced sales need this uniqueness, and most sales will
-- never have a value here at all.
create unique index sales_business_client_transaction_id_key
  on sales (business_id, client_transaction_id)
  where client_transaction_id is not null;

-- ── inventory_movements: a new, always-force-through reason ─────────────

alter table inventory_movements drop constraint inventory_movements_reason_check;
alter table inventory_movements add constraint inventory_movements_reason_check
  check (reason in (
    'receive', 'adjustment', 'stock_count',
    'sale', 'sale_refund', 'sale_cancelled',
    'sale_synced', -- 0052
    'transfer_in', 'transfer_out'
  ));

-- Same permission as an ordinary sale (sales.process) — a synced sale is
-- still a sale the till rang up, just late. One narrow policy per reason
-- is the pattern inventory_movements_insert_sale/_refund/_cancel already
-- use; this follows it rather than widening an existing OR-list.
create policy inventory_movements_insert_sale_synced on inventory_movements
  for insert
  with check (
    reason = 'sale_synced'
    and app_has_permission(business_id, 'sales.process')
  );

-- ── notifications: the new alert type this can raise ─────────────────────

alter table notifications drop constraint notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('refund_created', 'sale_voided', 'inventory_negative_from_sync'));

comment on table notifications is
  'Persisted, append-only log of EVENT-type notifications only (something that happened once, at a specific time). Written only by void_sale()/create_refund()/apply_inventory_movement() (0052, for a synced sale that oversold), each running with the privilege it needs to do so — the INSERT policies below are the real gate for the first two; apply_inventory_movement() is SECURITY DEFINER and writes directly, the same way it already does for stock_levels, since only it can know at the moment a movement lands whether that movement just took stock negative.';

-- No new INSERT policy needed for 'inventory_negative_from_sync': it is
-- written only by apply_inventory_movement(), which is SECURITY DEFINER
-- and therefore not subject to this table's RLS at all — same as its
-- existing stock_levels write. A direct client insert claiming this type
-- is still refused: it matches none of notifications_insert's per-type
-- checks below, so it falls through to that policy's implicit deny.

-- A SEPARATE, type-scoped select policy for the new alert — not a widened
-- clause on notifications_select itself. Multiple permissive RLS policies
-- on the same table OR together, so this only ADDS visibility, it never
-- narrows the original policy.
--
-- The first draft of this migration instead added a bare
-- "or app_has_permission(business_id, 'inventory.view')" to
-- notifications_select directly. That looked like the same one-line
-- extension 0034's three-clause "or" chain invites, but notifications_select
-- is type-agnostic — it does not filter by which event a row IS, only
-- whether the caller holds ANY of the listed permissions, and then admits
-- every event-type row in the business. In the seeded role matrix a
-- Cashier holds inventory.view (needed for stock lookups at the till), so
-- that draft accidentally let every Cashier read the full sale_voided/
-- refund_created event log too — a real regression, caught by
-- tests/security/notifications.sql's existing "a Cashier holds neither
-- reports.view nor sales.void/sales.refund and should see NEITHER event
-- type" assertion when this migration was run against a real local
-- Postgres instance. Scoping the grant to `type = 'inventory_negative_from_sync'`
-- in its own policy keeps inventory.view holders blind to voids/refunds,
-- exactly as before this migration.
create policy notifications_select_inventory_sync on notifications
  for select
  using (
    type = 'inventory_negative_from_sync'
    and app_has_permission(business_id, 'inventory.view')
  );

-- ── apply_inventory_movement(): the escape hatch itself ──────────────────
--
-- Reproduced in full from 0020's live body; the only change is the new
-- branch for reason = 'sale_synced', marked below.
create or replace function apply_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_new_quantity numeric(14, 3);
  v_allow_negative boolean;
begin
  insert into stock_levels (business_id, branch_id, variant_id, quantity, updated_at)
  values (new.business_id, new.branch_id, new.variant_id, new.quantity_delta, now())
  on conflict (branch_id, variant_id) do update
    set quantity   = stock_levels.quantity + excluded.quantity,
        updated_at = now()
  returning quantity into v_new_quantity;

  if v_new_quantity < 0 then
    if new.reason = 'sale_synced' then
      -- 0052: land it regardless of allow_negative_stock — a sale that
      -- already happened in the shop cannot be refused retroactively —
      -- and record the shortfall rather than silently absorb it.
      --
      -- reference_id is nullable on inventory_movements itself (other
      -- reasons, e.g. 'adjustment', legitimately have none), but this
      -- notification's reference_id is NOT NULL and create_sale() always
      -- supplies one for a sale_synced row. A caller that reaches this
      -- trigger some other way (a direct insert, or a future call site)
      -- without one would otherwise fail on that raw NOT NULL constraint
      -- — an internal implementation detail the master spec forbids
      -- surfacing. Raise a clean, expected error instead, tested by
      -- tests/security/offline_sync.sql.
      if new.reference_id is null then
        raise exception 'A synced sale movement must reference the sale it came from'
          using errcode = 'P0001';
      end if;

      insert into notifications (
        business_id, branch_id, type, severity, reference_type, reference_id,
        actor_user_id, data
      )
      values (
        new.business_id, new.branch_id, 'inventory_negative_from_sync', 'warning',
        'sale', new.reference_id, auth.uid(),
        jsonb_build_object(
          'variant_id', new.variant_id,
          'quantity_delta', new.quantity_delta,
          'quantity_on_hand', v_new_quantity
        )
      );
    else
      select coalesce((pos_settings ->> 'allow_negative_stock')::boolean, false)
      into v_allow_negative
      from business_settings
      where business_id = new.business_id;

      if not coalesce(v_allow_negative, false) then
        raise exception 'Not enough stock: this would leave % on hand', v_new_quantity
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  return new;
end;
$$;

comment on function apply_inventory_movement() is
  'AFTER INSERT on inventory_movements: applies the delta to stock_levels in the same transaction. Refuses to go negative unless the business opted into allow_negative_stock, EXCEPT for reason = sale_synced (0052), which always lands and instead writes an inventory_negative_from_sync notification — a synced offline sale cannot be refused after the fact. SECURITY DEFINER because stock_levels and notifications both grant ordinary users no direct write access for this.';

-- ═══════════════════════════════════════════════════════════════════════
-- ── create_sale(): the idempotency key, the momo refusal, the escape hatch
-- ═══════════════════════════════════════════════════════════════════════
--
-- Same signature as the live (0045) function plus one new trailing
-- default parameter. A Postgres function's identity is its NAME PLUS its
-- PARAMETER TYPE LIST — default values play no part in that identity, so
-- appending a parameter always creates a distinct, separately-overloaded
-- function rather than replacing the old one, no matter how "compatible"
-- the two signatures look. Confirmed this the hard way: applying an
-- earlier draft of this migration against a real local Postgres left
-- BOTH the 7-arg and new 8-arg create_sale() in place at once, and every
-- call site relying on p_payments' default (i.e. every 6-arg call) broke
-- with "function create_sale(...) is not unique". 0022 already hit this
-- exact trap when it went from 6 args to 7 and got it right: it drops
-- the old signature explicitly before (re)creating the new one. This
-- migration follows that same precedent instead of the "CREATE OR
-- REPLACE alone is enough" assumption the first draft made.
drop function if exists create_sale(uuid, uuid, uuid, text, numeric, jsonb, jsonb);

create or replace function create_sale(
  p_branch_id uuid,
  p_cashier_id uuid,
  p_customer_id uuid,
  p_payment_method text,
  p_amount_tendered numeric,
  p_items jsonb,                  -- [{variant_id, quantity, rendered_by, provider_id}]
  p_payments jsonb default null,  -- [{method, amount, momo_number, momo_network}]
  -- Set ONLY by the offline-sync endpoint (app/api/sync/route.ts), never by
  -- the ordinary till UI. Makes a retried sync a safe no-op (0052) and, for
  -- exactly this case, tells the stock trigger below to land the sale even
  -- over what's on hand rather than refuse it retroactively — see this
  -- migration's own header for the full reasoning.
  p_client_transaction_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_business_id   uuid;
  v_sale_id       uuid;
  v_existing_sale_id uuid;
  v_item          jsonb;
  v_pay           jsonb;
  v_variant       record;
  v_qty           numeric(14, 3);
  v_reference     text;
  v_settings      jsonb;
  v_vat_enabled   boolean;
  v_inclusive     boolean;
  v_vat           numeric;
  v_levies        numeric;
  v_gross         numeric(14, 2);
  v_base          numeric;
  v_line_tax      numeric(14, 2);
  v_line_subtotal numeric(14, 2);
  v_subtotal      numeric(14, 2) := 0;
  v_tax_total     numeric(14, 2) := 0;
  v_total         numeric(14, 2) := 0;
  v_change        numeric(14, 2) := 0;
  v_lines         jsonb := '[]'::jsonb;
  v_tenders       jsonb;
  v_method        text;
  v_amount        numeric(14, 2);
  v_cash          numeric(14, 2) := 0;
  v_momo          numeric(14, 2) := 0;
  v_credit        numeric(14, 2) := 0;
  v_methods       text[] := '{}';
  v_credit_is_total boolean := false;
  v_momo_is_remainder boolean := false;
  v_summary       text;
  v_status        text;
  v_payment_id    uuid;
  -- Who rendered a service line, and whether this line is one at all.
  -- Exactly one of the next two may be set for a service line (0045).
  v_rendered_by   uuid;
  v_provider_id   uuid;
begin
  if p_items is null or jsonb_array_length(p_items) < 1 then
    raise exception 'A sale needs at least one item' using errcode = 'P0001';
  end if;

  -- The cashier is always whoever is actually signed in — never a value
  -- the client chooses (0039). p_cashier_id stays in the signature only
  -- so nothing needs a new overload; a caller may still pass their own
  -- id for clarity, but anything else is refused outright rather than
  -- silently ignored or silently honoured.
  if p_cashier_id is not null and p_cashier_id <> auth.uid() then
    raise exception 'A sale can only be attributed to the account that is signed in' using errcode = '42501';
  end if;

  -- Backwards compatible: a caller that passes no payments (everything
  -- written before this migration, and every existing test) gets exactly
  -- the old single-tender behaviour, derived from the two arguments it
  -- did pass.
  if p_payments is null then
    if p_payment_method not in ('cash', 'credit') then
      raise exception 'Unknown payment method' using errcode = '22023';
    end if;
    -- Note what the old form does NOT carry: an amount for a credit sale.
    -- It passed amount_tendered = 0 there, meaning "the whole total",
    -- which is not known until the lines are priced. The amount is left
    -- out and filled in below rather than validated as a zero payment.
    v_tenders := case
      when p_payment_method = 'credit'
        then jsonb_build_array(jsonb_build_object('method', 'credit'))
      else jsonb_build_array(jsonb_build_object(
        'method', 'cash', 'amount', coalesce(p_amount_tendered, 0)))
    end;
  else
    v_tenders := p_payments;
  end if;

  if jsonb_array_length(v_tenders) < 1 then
    raise exception 'A sale needs at least one payment' using errcode = 'P0001';
  end if;

  select business_id into v_business_id from branches where id = p_branch_id;
  if v_business_id is null then
    raise exception 'Invalid branch_id: branch not found' using errcode = 'P0002';
  end if;

  -- Idempotent replay (0052): the same offline sale retried after a flaky
  -- connection must land once, not twice. Scoped to this cashier's own
  -- visibility into `sales` (sales_select, 0037) rather than bypassing RLS —
  -- the one caller who would ever legitimately retry a given
  -- client_transaction_id is the same signed-in session that generated it
  -- offline, and that session can always see its own sales regardless of
  -- reports.view. The unique index this migration adds on
  -- (business_id, client_transaction_id) is the actual backstop if this
  -- lookup ever misses for some other reason: a true duplicate insert fails
  -- loudly rather than landing twice.
  if p_client_transaction_id is not null then
    select id into v_existing_sale_id
    from sales
    where business_id = v_business_id
      and client_transaction_id = p_client_transaction_id;

    if v_existing_sale_id is not null then
      return v_existing_sale_id;
    end if;
  end if;

  if p_customer_id is not null then
    if not exists (select 1 from customers where id = p_customer_id and business_id = v_business_id) then
      raise exception 'Invalid customer_id: customer not found' using errcode = 'P0002';
    end if;
  end if;

  -- ── the tenders, before anything is written ───────────────────────────
  for v_pay in select * from jsonb_array_elements(v_tenders)
  loop
    v_method := v_pay ->> 'method';
    if v_method not in ('cash', 'momo', 'credit') then
      raise exception 'Unknown payment method' using errcode = '22023';
    end if;
    -- A mobile money charge needs a live prompt to the customer's own
    -- phone right now (0022) — there is no "prompt them later once we're
    -- back online" version of that. The architecture doc's Section 7 is
    -- explicit that only cash and on-account are permitted offline; this
    -- is the server-side half of that rule; app/api/sync/route.ts refusing
    -- the request first is the other half, and neither is trusted alone.
    if v_method = 'momo' and p_client_transaction_id is not null then
      raise exception 'Mobile money is not available for a sale synced from offline' using errcode = 'P0001';
    end if;
    if v_method = any (v_methods) then
      raise exception 'The same payment method was given twice' using errcode = 'P0001';
    end if;
    v_methods := v_methods || v_method;

    if v_method = 'cash' then
      -- Cash is the one tender that may be short at this point: it is
      -- allowed to be zero here and checked against the total below,
      -- because the old two-argument form passes the tendered amount.
      v_cash := coalesce((v_pay ->> 'amount')::numeric, 0);
      if v_cash < 0 then
        raise exception 'Cash tendered cannot be negative' using errcode = 'P0001';
      end if;
    elsif v_method = 'credit' and coalesce(jsonb_typeof(v_pay -> 'amount'), 'null') = 'null' then
      -- "The whole total", filled in once the lines are priced.
      v_credit_is_total := true;

    elsif v_method = 'momo' and coalesce(jsonb_typeof(v_pay -> 'amount'), 'null') = 'null' then
      -- "Whatever the cash did not cover", filled in once the lines are
      -- priced. This is how the till asks for a mobile money charge: it
      -- never names the amount, because it does not know the authoritative
      -- total and must not be able to prompt a customer's phone for a
      -- figure of its own choosing.
      v_momo_is_remainder := true;
      if coalesce(v_pay ->> 'momo_number', '') = '' then
        raise exception 'A mobile money payment needs a phone number' using errcode = 'P0001';
      end if;
      if coalesce(v_pay ->> 'momo_network', '') not in ('mtn', 'vod', 'atl') then
        raise exception 'Choose the customer''s mobile money network' using errcode = 'P0001';
      end if;
    else
      v_amount := (v_pay ->> 'amount')::numeric;
      if v_amount is null or v_amount <= 0 then
        raise exception 'Every payment needs an amount greater than zero' using errcode = 'P0001';
      end if;
      if v_method = 'momo' then
        v_momo := v_amount;
        if coalesce(v_pay ->> 'momo_number', '') = '' then
          raise exception 'A mobile money payment needs a phone number' using errcode = 'P0001';
        end if;
        if coalesce(v_pay ->> 'momo_network', '') not in ('mtn', 'vod', 'atl') then
          raise exception 'Choose the customer''s mobile money network' using errcode = 'P0001';
        end if;
      else
        v_credit := v_amount;
      end if;
    end if;
  end loop;

  -- On account is not a tender you can top up at the counter. Part-paying
  -- an account sale is a payment AGAINST the account (0017), recorded
  -- separately — mixing them here would mean re-checking a credit limit
  -- long after the customer has left.
  if (v_credit > 0 or v_credit_is_total) and array_length(v_methods, 1) > 1 then
    raise exception 'An account sale cannot be part-paid at the till' using errcode = 'P0001';
  end if;

  if (v_credit > 0 or v_credit_is_total) and p_customer_id is null then
    raise exception 'A credit sale needs a customer' using errcode = 'P0001';
  end if;

  -- 0020 wrote the account entry as the caller, so the account ledger's
  -- own insert policy demanded customers.view. finalize_sale writes it as
  -- its owner now, which would quietly have dropped that requirement, so
  -- it is asserted here instead of being lost in the refactor.
  if (v_credit > 0 or v_credit_is_total)
     and not (app_has_permission(v_business_id, 'customers.view') or app_is_super_admin()) then
    raise exception 'Missing permission: customers.view' using errcode = '42501';
  end if;

  select tax_settings into v_settings from business_settings where business_id = v_business_id;
  v_vat_enabled := coalesce((v_settings ->> 'vat_enabled')::boolean, false);
  v_inclusive   := coalesce((v_settings ->> 'vat_inclusive')::boolean, true);
  v_vat         := coalesce((v_settings ->> 'vat_rate')::numeric, 0);
  v_levies      := coalesce((v_settings ->> 'nhil_levy_rate')::numeric, 0)
                 + coalesce((v_settings ->> 'getfund_levy_rate')::numeric, 0)
                 + coalesce((v_settings ->> 'covid_levy_rate')::numeric, 0);

  -- FIRST PASS: price every line and total the sale, writing nothing.
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every line needs a quantity greater than zero' using errcode = 'P0001';
    end if;

    -- Also read the product's type, so a service line can skip the stock
    -- machinery entirely further down.
    select v.id, v.sku, v.selling_price, v.cost_price, v.status, p.name, p.tax_category, p.type as product_type
    into v_variant
    from product_variants v
    join products p on p.id = v.product_id
    where v.id = (v_item ->> 'variant_id')::uuid
      and v.business_id = v_business_id;

    if v_variant.id is null then
      raise exception 'Invalid variant_id: product not found' using errcode = 'P0002';
    end if;
    if v_variant.status <> 'active' then
      raise exception 'That product is archived and cannot be sold' using errcode = 'P0001';
    end if;

    -- Who did the work. Required and validated for a service, from
    -- EITHER pool (0045) — ignored entirely for a product; a bogus value
    -- there grants nothing, so it is simply dropped rather than treated
    -- as an error.
    v_rendered_by := nullif(v_item ->> 'rendered_by', '')::uuid;
    v_provider_id := nullif(v_item ->> 'provider_id', '')::uuid;

    if v_variant.product_type = 'service' then
      if v_rendered_by is not null and v_provider_id is not null then
        raise exception 'Choose one renderer for "%", not two', v_variant.name using errcode = 'P0001';
      end if;
      if v_rendered_by is null and v_provider_id is null then
        raise exception 'Choose who rendered "%"', v_variant.name using errcode = 'P0001';
      end if;

      if v_rendered_by is not null then
        if not exists (
          select 1 from profiles
          where id = v_rendered_by and business_id = v_business_id and status = 'active'
        ) then
          raise exception 'That person is not an active member of this business' using errcode = 'P0002';
        end if;
      else
        -- Also branch-scoped, unlike a staff profile: a service provider
        -- (0045) is tied to one branch, so naming one from a different
        -- branch than this sale is refused the same way a foreign
        -- customer or branch id already is, not silently allowed.
        if not exists (
          select 1 from service_providers
          where id = v_provider_id
            and business_id = v_business_id
            and branch_id = p_branch_id
            and status = 'active'
        ) then
          raise exception 'That service provider is not active at this branch' using errcode = 'P0002';
        end if;
      end if;
    else
      v_rendered_by := null;
      v_provider_id := null;
    end if;

    v_gross := round(v_variant.selling_price * v_qty, 2);

    if not v_vat_enabled or v_variant.tax_category in ('zero_rated', 'exempt') then
      v_line_tax := 0;
      v_line_subtotal := v_gross;
    elsif v_inclusive then
      v_base := v_gross / ((1 + v_levies) * (1 + v_vat));
      v_line_subtotal := round(v_base, 2);
      v_line_tax := v_gross - v_line_subtotal;
    else
      v_line_subtotal := v_gross;
      v_line_tax := round((v_gross * v_levies) + ((v_gross * (1 + v_levies)) * v_vat), 2);
      v_gross := v_line_subtotal + v_line_tax;
    end if;

    v_lines := v_lines || jsonb_build_object(
      'variant_id', v_variant.id,
      'description', v_variant.name,
      'sku', v_variant.sku,
      'quantity', v_qty,
      'unit_price', v_variant.selling_price,
      -- What this unit COST us, captured now. Cost prices change; a
      -- profit figure derived from today's cost applied to last month's
      -- sale is not a rounder number, it is a wrong one.
      'unit_cost', coalesce(v_variant.cost_price, 0),
      'tax_category', v_variant.tax_category,
      'line_subtotal', v_line_subtotal,
      'line_tax', v_line_tax,
      'line_total', v_gross,
      'is_service', (v_variant.product_type = 'service'),
      'rendered_by', v_rendered_by,
      'provider_id', v_provider_id
    );

    v_subtotal  := v_subtotal + v_line_subtotal;
    v_tax_total := v_tax_total + v_line_tax;
    v_total     := v_total + v_gross;
  end loop;

  -- An account sale is for the whole total by definition; now that the
  -- lines are priced, we know what that is.
  if v_credit_is_total then
    v_credit := v_total;
  end if;

  if v_momo_is_remainder then
    v_momo := v_total - v_cash;
    if v_momo <= 0 then
      raise exception 'The cash already covers this sale — there is nothing to charge to mobile money'
        using errcode = 'P0001';
    end if;
  end if;

  -- ── does the money add up? ────────────────────────────────────────────
  if v_momo + v_credit > v_total then
    raise exception 'The payments come to more than the sale' using errcode = 'P0001';
  end if;

  if v_credit > 0 and v_credit <> v_total then
    raise exception 'An account sale must be for the whole amount' using errcode = 'P0001';
  end if;

  if v_cash + v_momo + v_credit < v_total then
    raise exception 'Not enough tendered for a total of %', v_total using errcode = 'P0001';
  end if;

  if v_cash > 0 then
    v_change := v_cash - (v_total - v_momo - v_credit);
  end if;

  -- A momo charge has not happened yet — it is a prompt on a phone that
  -- the customer has three minutes to approve.
  v_status := case when v_momo > 0 then 'awaiting_payment' else 'completed' end;

  v_summary := case
    when array_length(v_methods, 1) > 1 then 'split'
    when v_credit > 0 then 'credit'
    when v_momo > 0 then 'momo'
    else 'cash'
  end;

  -- Receipt number, serialised per business so two tills cannot both
  -- claim R-000042.
  perform pg_advisory_xact_lock(hashtextextended('receipt:' || v_business_id::text, 0));

  v_reference := next_receipt_number(v_business_id);

  insert into sales (
    business_id, branch_id, receipt_number, customer_id, status, payment_method,
    subtotal, tax_total, total, amount_tendered, change_given, cashier_id, created_by,
    client_transaction_id
  )
  values (
    v_business_id, p_branch_id, v_reference, p_customer_id,
    'awaiting_payment', v_summary,
    v_subtotal, v_tax_total, v_total, v_cash, v_change,
    -- Always the signed-in account (0039) — never p_cashier_id.
    auth.uid(), auth.uid(),
    p_client_transaction_id
  )
  returning id into v_sale_id;

  -- SECOND PASS: the lines. A product line also takes stock out; a
  -- service line never touches the inventory ledger at all — there is
  -- nothing to take off a shelf.
  for v_item in select * from jsonb_array_elements(v_lines)
  loop
    insert into sale_items (
      sale_id, business_id, variant_id, description, sku, quantity,
      unit_price, unit_cost, cost_is_estimated, tax_category,
      line_subtotal, line_tax, line_total, rendered_by, provider_id
    )
    values (
      v_sale_id, v_business_id, (v_item ->> 'variant_id')::uuid,
      v_item ->> 'description', v_item ->> 'sku', (v_item ->> 'quantity')::numeric,
      (v_item ->> 'unit_price')::numeric, (v_item ->> 'unit_cost')::numeric,
      false, -- recorded at the moment of sale, not guessed afterwards
      v_item ->> 'tax_category',
      (v_item ->> 'line_subtotal')::numeric, (v_item ->> 'line_tax')::numeric,
      (v_item ->> 'line_total')::numeric,
      nullif(v_item ->> 'rendered_by', '')::uuid,
      nullif(v_item ->> 'provider_id', '')::uuid
    );

    if not (v_item ->> 'is_service')::boolean then
      insert into inventory_movements (
        business_id, branch_id, variant_id, quantity_delta, reason,
        reference_type, reference_id, note
      )
      values (
        '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
        p_branch_id, (v_item ->> 'variant_id')::uuid, -(v_item ->> 'quantity')::numeric,
        -- 'sale_synced' (0052) tells apply_inventory_movement() to land this
        -- even over what's on hand rather than refuse it — a sale that
        -- already happened in the shop cannot be refused retroactively —
        -- and to record the resulting shortfall as a notification instead
        -- of silently absorbing it.
        case when p_client_transaction_id is not null then 'sale_synced' else 'sale' end,
        'sale', v_sale_id, 'Sold on ' || v_reference
      );
    end if;
  end loop;

  -- THIRD PASS: the tenders themselves.
  for v_pay in select * from jsonb_array_elements(v_tenders)
  loop
    v_method := v_pay ->> 'method';
    v_amount := case
      when v_method = 'cash' then v_cash
      when v_method = 'credit' then v_credit
      when v_method = 'momo' then v_momo
      else (v_pay ->> 'amount')::numeric
    end;

    continue when v_amount is null or v_amount <= 0;

    v_payment_id := gen_random_uuid();

    insert into sale_payments (
      id, business_id, sale_id, branch_id, method, amount, status,
      provider, provider_reference, momo_number, momo_network, settled_at, created_by
    )
    values (
      v_payment_id, v_business_id, v_sale_id, p_branch_id, v_method, v_amount,
      case when v_method = 'momo' then 'pending' else 'success' end,
      case when v_method = 'momo' then 'paystack' else null end,
      case when v_method = 'momo' then v_payment_id::text else null end,
      v_pay ->> 'momo_number', v_pay ->> 'momo_network',
      case when v_method = 'momo' then null else now() end,
      auth.uid()
    );
  end loop;

  -- Nothing to wait for: complete it now, through the same function the
  -- webhook will use.
  if v_status = 'completed' then
    perform finalize_sale(v_sale_id);
  end if;

  return v_sale_id;
end;
$$;

grant execute on function create_sale(uuid, uuid, uuid, text, numeric, jsonb, jsonb, uuid) to authenticated;

comment on function create_sale(uuid, uuid, uuid, text, numeric, jsonb, jsonb, uuid) is
  'Prices and records a sale entirely server-side (money is computed here, never sent) and moves stock through the inventory_movements ledger, never touching stock_levels directly. 0052 adds an optional client_transaction_id: set only by the offline-sync endpoint, it makes a retried sync idempotent, refuses mobile money, and lets the resulting stock movement land negative (flagged, never silently absorbed) instead of being refused retroactively.';