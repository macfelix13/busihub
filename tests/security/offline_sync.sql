-- Busihub — behaviour/security test for offline sale sync (migration 0052).
--
-- 0052 extends create_sale() with a trailing p_client_transaction_id
-- parameter so a sale rung up offline and replayed later (retried by the
-- service worker, or genuinely submitted twice) lands exactly once, never
-- takes a mobile-money tender, and — because a sale that already happened
-- in the shop cannot be refused after the fact — is allowed to push stock
-- negative, with the shortfall recorded as a new notification instead of
-- silently absorbed. This file tests each of those guarantees directly,
-- plus the two places a synced sale could otherwise leak across tenants
-- or over-widen who sees what: the partial unique index backing the
-- idempotency key, and the new notification type's own SELECT policy.
--
-- `TEST FAILED` raises carry SQLSTATE ZZ999, which no handler here catches
-- (the default, P0001, is caught below as an expected rejection).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures: business A (existing demo store) gets a synced-sale item and
-- a Cashier-only account; a second, unrelated business B is registered
-- fresh to prove the idempotency key and the new notification type are
-- both scoped per-business, not globally ─────────────────────────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000901',
   'authenticated', 'authenticated', 'sync-cashier@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000902',
   'authenticated', 'authenticated', 'sync-shop-b-owner@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select create_product(
  (select id from businesses where slug = 'busihub-demo-store'),
  'Sync Test Item', null, null, 'each', 'standard',
  '{}'::text[],
  '[{"sku": "SYNC-1", "barcode": "", "variant_options": {}, "cost_price": 2, "selling_price": 20}]'::jsonb
);
reset role;
reset request.jwt.claim.sub;

-- register_business() reads auth.uid() at call time, so its result has to
-- be captured while role authenticated is active; it is handed to the
-- rest of the script via plain session GUCs (same technique
-- cashier_own_sales_visibility.sql uses to pass ids between blocks),
-- since a superuser-owned helper table is created below only after
-- role is reset.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000902';
do $$
declare v_biz uuid; v_branch uuid;
begin
  select business_id, branch_id into v_biz, v_branch
  from register_business('Sync Test Shop B', 'Kofi', 'Mensah');
  perform set_config('sync.biz_b', v_biz::text, false);
  perform set_config('sync.branch_b', v_branch::text, false);
end $$;
select create_product(
  current_setting('sync.biz_b')::uuid,
  'Sync Test Item B', null, null, 'each', 'standard',
  '{}'::text[],
  '[{"sku": "SYNC-B-1", "barcode": "", "variant_options": {}, "cost_price": 2, "selling_price": 20}]'::jsonb
);
reset role;
reset request.jwt.claim.sub;

create table sync_ids as
select
  (select id from businesses where slug = 'busihub-demo-store')     as biz_a,
  current_setting('sync.biz_b')::uuid                               as biz_b,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'busihub-demo-store') and b.is_main)  as branch_a,
  current_setting('sync.branch_b')::uuid                            as branch_b,
  (select id from product_variants where sku = 'SYNC-1')            as item_a,
  (select id from product_variants where sku = 'SYNC-B-1')          as item_b;

do $$
declare r record;
begin
  select * into r from sync_ids;
  if r.biz_a is null or r.biz_b is null or r.branch_a is null or r.branch_b is null
     or r.item_a is null or r.item_b is null then
    raise exception 'TEST FIXTURE BROKEN: sync_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

grant select on sync_ids to authenticated;

-- A Cashier-only account in business A (sales.process + inventory.view,
-- no reports.view/sales.void/sales.refund) — used below to reconfirm,
-- inside this migration's own test file, the exact regression this
-- migration's first draft introduced and then had fixed: inventory.view
-- must see the new inventory_negative_from_sync alert without also seeing
-- the sale_voided/refund_created event log.
do $$
declare v_biz uuid; v_branch uuid; v_cashier_role uuid;
begin
  select biz_a, branch_a into v_biz, v_branch from sync_ids;
  select id into v_cashier_role from roles where business_id = v_biz and name = 'Cashier';

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000901', v_biz, 'Sync', 'Cashier', 'sync-cashier@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000000901', v_cashier_role,
            '00000000-0000-0000-0000-000000000001')
  on conflict do nothing;
end $$;

-- Stock: 5 of item_a in business A, 5 of item_b in business B.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
select branch_a, item_a, 5, 'receive' from sync_ids;
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000902';
insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
select branch_b, item_b, 5, 'receive' from sync_ids;
reset role;
reset request.jwt.claim.sub;

-- ── 1. Idempotent replay: same client_transaction_id twice returns the
-- SAME sale, no double stock movement, no duplicate rows ─────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare
  v_ctid uuid := gen_random_uuid();
  v_sale_1 uuid;
  v_sale_2 uuid;
  v_sale_count int;
  v_movement_count int;
  v_stock numeric;
begin
  select create_sale(
    (select branch_a from sync_ids), null, null, 'cash', 20,
    jsonb_build_array(jsonb_build_object('variant_id', (select item_a from sync_ids), 'quantity', 1)),
    null, v_ctid
  ) into v_sale_1;

  -- Replay: identical client_transaction_id, called again in a later
  -- "session" (same DB session here, but nothing in create_sale relies on
  -- that — the short-circuit is keyed purely on business_id + the id).
  select create_sale(
    (select branch_a from sync_ids), null, null, 'cash', 20,
    jsonb_build_array(jsonb_build_object('variant_id', (select item_a from sync_ids), 'quantity', 1)),
    null, v_ctid
  ) into v_sale_2;

  if v_sale_1 is distinct from v_sale_2 then
    raise exception 'TEST FAILED: replaying the same client_transaction_id produced a different sale id (% vs %)',
      v_sale_1, v_sale_2 using errcode = 'ZZ999';
  end if;

  select count(*) into v_sale_count from sales where client_transaction_id = v_ctid;
  if v_sale_count <> 1 then
    raise exception 'TEST FAILED: expected exactly 1 sale row for this client_transaction_id, found %', v_sale_count
      using errcode = 'ZZ999';
  end if;

  select count(*) into v_movement_count from inventory_movements
  where reference_type = 'sale' and reference_id = v_sale_1;
  if v_movement_count <> 1 then
    raise exception 'TEST FAILED: replay created % inventory movements, expected 1', v_movement_count
      using errcode = 'ZZ999';
  end if;

  select quantity into v_stock from stock_levels
  where branch_id = (select branch_a from sync_ids) and variant_id = (select item_a from sync_ids);
  if v_stock <> 4 then
    raise exception 'TEST FAILED: expected stock 5 -> 4 after ONE effective sale, got %', v_stock
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: replaying the same client_transaction_id returns the same sale, no double effect';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 2. The idempotency key is scoped per business, not global: two
-- different businesses may independently reuse the identical UUID ────────

do $$
declare
  v_shared_ctid uuid := gen_random_uuid();
  v_sale_a uuid;
  v_sale_b uuid;
begin
  set role authenticated;
  set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
  select create_sale(
    (select branch_a from sync_ids), null, null, 'cash', 20,
    jsonb_build_array(jsonb_build_object('variant_id', (select item_a from sync_ids), 'quantity', 1)),
    null, v_shared_ctid
  ) into v_sale_a;
  reset role;
  reset request.jwt.claim.sub;

  set role authenticated;
  set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000902';
  select create_sale(
    (select branch_b from sync_ids), null, null, 'cash', 20,
    jsonb_build_array(jsonb_build_object('variant_id', (select item_b from sync_ids), 'quantity', 1)),
    null, v_shared_ctid
  ) into v_sale_b;
  reset role;
  reset request.jwt.claim.sub;

  if v_sale_a is null or v_sale_b is null or v_sale_a = v_sale_b then
    raise exception 'TEST FAILED: two businesses reusing the same client_transaction_id collided (a=%, b=%)',
      v_sale_a, v_sale_b using errcode = 'ZZ999';
  end if;

  if (select count(*) from sales where client_transaction_id = v_shared_ctid) <> 2 then
    raise exception 'TEST FAILED: expected one sale per business for the shared id, found %',
      (select count(*) from sales where client_transaction_id = v_shared_ctid) using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: client_transaction_id uniqueness is per-business, not global';
end $$;

-- ── 3. A synced sale that oversells lands anyway, goes negative, and
-- writes exactly one inventory_negative_from_sync notification — while
-- the equivalent ONLINE sale on the same stock is still refused ──────────

do $$
declare
  v_ctid uuid := gen_random_uuid();
  v_sale uuid;
  v_stock numeric;
  v_notif record;
  v_notif_count int;
begin
  set role authenticated;
  set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

  -- Only 3 left (5 received, minus 1 in test 1, minus 1 more in test 2's
  -- shared-ctid sale); sell 10 as a synced sale.
  select create_sale(
    (select branch_a from sync_ids), null, null, 'cash', 200,
    jsonb_build_array(jsonb_build_object('variant_id', (select item_a from sync_ids), 'quantity', 10)),
    null, v_ctid
  ) into v_sale;

  if v_sale is null then
    raise exception 'TEST FAILED: a synced oversell should still complete, got no sale id' using errcode = 'ZZ999';
  end if;

  select quantity into v_stock from stock_levels
  where branch_id = (select branch_a from sync_ids) and variant_id = (select item_a from sync_ids);
  if v_stock <> -7 then
    raise exception 'TEST FAILED: expected stock to land at 3 - 10 = -7, got %', v_stock using errcode = 'ZZ999';
  end if;

  if not exists (
    select 1 from inventory_movements
    where reference_type = 'sale' and reference_id = v_sale and reason = 'sale_synced'
  ) then
    raise exception 'TEST FAILED: the synced oversell did not record reason = sale_synced' using errcode = 'ZZ999';
  end if;

  select count(*) into v_notif_count from notifications
  where type = 'inventory_negative_from_sync' and reference_id = v_sale;
  if v_notif_count <> 1 then
    raise exception 'TEST FAILED: expected exactly 1 inventory_negative_from_sync notification, found %', v_notif_count
      using errcode = 'ZZ999';
  end if;

  select * into v_notif from notifications
  where type = 'inventory_negative_from_sync' and reference_id = v_sale;
  if v_notif.business_id <> (select biz_a from sync_ids) then
    raise exception 'TEST FAILED: notification business_id wrong (%)', v_notif.business_id using errcode = 'ZZ999';
  end if;
  if v_notif.branch_id <> (select branch_a from sync_ids) then
    raise exception 'TEST FAILED: notification branch_id wrong (%)', v_notif.branch_id using errcode = 'ZZ999';
  end if;
  if v_notif.reference_type <> 'sale' then
    raise exception 'TEST FAILED: notification reference_type wrong (%)', v_notif.reference_type using errcode = 'ZZ999';
  end if;
  if (v_notif.data ->> 'variant_id')::uuid <> (select item_a from sync_ids) then
    raise exception 'TEST FAILED: notification data.variant_id wrong (%)', v_notif.data ->> 'variant_id'
      using errcode = 'ZZ999';
  end if;
  if (v_notif.data ->> 'quantity_on_hand')::numeric <> -7 then
    raise exception 'TEST FAILED: notification data.quantity_on_hand wrong (%)', v_notif.data ->> 'quantity_on_hand'
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a synced oversell lands, goes negative (%), and records exactly one accurate notification', v_stock;

  -- Now the online path, same branch, same now-negative stock: a normal
  -- (non-synced) sale must still be refused exactly as before 0052.
  begin
    perform create_sale(
      (select branch_a from sync_ids), null, null, 'cash', 200,
      jsonb_build_array(jsonb_build_object('variant_id', (select item_a from sync_ids), 'quantity', 1))
    );
    raise exception 'TEST FAILED: an ONLINE sale on negative/insufficient stock should still be refused' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: the online path is unchanged — still refuses to oversell without allow_negative_stock';
  end;

  reset role;
  reset request.jwt.claim.sub;
end $$;

-- ── 4. Mobile money is refused for a synced sale ──────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_ctid uuid := gen_random_uuid();
begin
  begin
    perform create_sale(
      (select branch_a from sync_ids), null, null, null, null,
      jsonb_build_array(jsonb_build_object('variant_id', (select item_a from sync_ids), 'quantity', 1)),
      jsonb_build_array(jsonb_build_object(
        'method', 'momo', 'amount', 20, 'momo_number', '0244555000', 'momo_network', 'mtn')),
      v_ctid
    );
    raise exception 'TEST FAILED: a synced sale accepted a momo tender' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: mobile money is refused for a synced sale';
  end;

  if exists (select 1 from sales where client_transaction_id = v_ctid) then
    raise exception 'TEST FAILED: the refused momo-synced sale still left a sale row behind' using errcode = 'ZZ999';
  end if;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 5. Only sales.process can insert a sale_synced movement directly ─────
-- (defence in depth below create_sale — a direct PostgREST insert
-- claiming reason = 'sale_synced' still goes through this policy). Also
-- covers the guard added to apply_inventory_movement() after this test
-- first caught it missing: a sale_synced movement with no reference_id
-- must be refused cleanly (P0001), not fall through to a raw NOT NULL
-- constraint violation on notifications.

do $$
declare v_biz uuid; v_branch uuid; v_item uuid;
begin
  select biz_a, branch_a, item_a into v_biz, v_branch, v_item from sync_ids;

  set role authenticated;
  set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000901'; -- Cashier, has sales.process

  -- 5a. A well-formed direct insert (real reference_id, stays non-negative)
  -- is allowed — sales.process is the gate, not a policy meant to block it.
  begin
    insert into inventory_movements (branch_id, variant_id, quantity_delta, reason, reference_type, reference_id)
    values (v_branch, v_item, -1, 'sale_synced', 'sale', gen_random_uuid());
    raise notice 'PASS: a sales.process holder may insert a sale_synced movement';
  exception when insufficient_privilege or sqlstate 'P0001' then
    raise exception 'TEST FAILED: a Cashier (sales.process) should be allowed to insert sale_synced' using errcode = 'ZZ999';
  end;

  -- 5b. The same insert with no reference_id, pushed negative, must raise
  -- the clean P0001 guard rather than an internal NOT NULL constraint error.
  begin
    insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
    values (v_branch, v_item, -100, 'sale_synced');
    raise exception 'TEST FAILED: a sale_synced movement with no reference_id should have been refused' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a sale_synced movement with no reference_id is refused cleanly, not as a raw constraint error';
  end;

  reset role;
  reset request.jwt.claim.sub;
end $$;

-- ── 6. The new notification type is scoped to inventory.view — and, the
-- specific regression this migration's first draft introduced, an
-- inventory.view-only holder (a Cashier) still sees NONE of the
-- sale_voided/refund_created event log ────────────────────────────────────

do $$
declare v_sync_count int; v_void_count int; v_refund_count int;
begin
  set role authenticated;
  set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000901'; -- Cashier: inventory.view only

  select count(*) into v_sync_count from notifications
  where business_id = (select biz_a from sync_ids) and type = 'inventory_negative_from_sync';
  if v_sync_count < 1 then
    raise exception 'TEST FAILED: a Cashier (inventory.view) should see inventory_negative_from_sync alerts, saw %',
      v_sync_count using errcode = 'ZZ999';
  end if;

  select count(*) into v_void_count from notifications
  where business_id = (select biz_a from sync_ids) and type = 'sale_voided';
  select count(*) into v_refund_count from notifications
  where business_id = (select biz_a from sync_ids) and type = 'refund_created';
  if v_void_count <> 0 or v_refund_count <> 0 then
    raise exception 'TEST FAILED: a Cashier holding only inventory.view should see NEITHER sale_voided nor refund_created (void %, refund %) — the exact regression 0052''s first draft introduced',
      v_void_count, v_refund_count using errcode = 'ZZ999';
  end if;

  reset role;
  reset request.jwt.claim.sub;

  raise notice 'PASS: inventory.view sees the new sync alert and nothing else from the event log';
end $$;

-- ── 7. Cross-tenant isolation for everything this migration added ───────
-- Business B must see none of business A's sales, movements or
-- notifications created above, and vice versa.

do $$
declare v_leak int;
begin
  set role authenticated;
  set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000902'; -- Owner of business B

  select count(*) into v_leak from sales where business_id = (select biz_a from sync_ids);
  if v_leak <> 0 then
    raise exception 'TEST FAILED: business B read % of business A''s sales', v_leak using errcode = 'ZZ999';
  end if;

  select count(*) into v_leak from notifications
  where business_id = (select biz_a from sync_ids) and type = 'inventory_negative_from_sync';
  if v_leak <> 0 then
    raise exception 'TEST FAILED: business B (Owner, has reports.view) read % of business A''s sync notifications — business_id scoping failed',
      v_leak using errcode = 'ZZ999';
  end if;

  select count(*) into v_leak from inventory_movements
  where business_id = (select biz_a from sync_ids) and reason = 'sale_synced';
  if v_leak <> 0 then
    raise exception 'TEST FAILED: business B read % of business A''s sale_synced movements', v_leak using errcode = 'ZZ999';
  end if;

  reset role;
  reset request.jwt.claim.sub;

  raise notice 'PASS: business B sees none of business A''s synced-sale data (sales, movements, or notifications)';
end $$;

drop table sync_ids;

\echo ''
\echo 'All offline-sync tests passed.'