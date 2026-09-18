-- Busihub — security tests for inventory expiry dates (migration 0055).
--
-- Covers the new stock_batches table's RLS (permission tiers, cross-
-- tenant isolation), expiring_stock_report()'s honesty filters (it only
-- ever surfaces a variant/branch that currently has stock on hand, and
-- never leaks across tenants), and that notification_feed_base() only
-- surfaces an expiring_stock alert once a business has actually turned
-- inventory_settings.track_expiry on — exercised directly against
-- Postgres + RLS, same approach as every other file in this directory.
--
-- Run against a throwaway Postgres loaded with
-- tests/db-harness/00_stub_supabase.sql + supabase/migrations/*.sql +
-- supabase/seed.sql (+ every earlier tests/security/*.sql file, per
-- .github/workflows/ci.yml's run order).
--
-- 11xx block: not used by any other tests/security/*.sql file (checked).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures: two fresh businesses, a product/branch in each ────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001100', 'authenticated', 'authenticated', 'expiryownerx@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001101', 'authenticated', 'authenticated', 'expiryownery@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001102', 'authenticated', 'authenticated', 'expirycashierx@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001100';
select register_business('Expiry Test Shop X', 'Adjoa', 'Sarpong');
select create_product(
  (select id from businesses where slug = 'expiry-test-shop-x'),
  'Test Yoghurt', null, null, 'each', 'standard',
  '{}'::text[],
  '[{"sku": "YOG-500ML", "barcode": "", "variant_options": {}, "cost_price": 8, "selling_price": 12}]'::jsonb
);
-- A second product that is never received — used below to prove
-- expiring_stock_report() never surfaces a variant with zero on hand,
-- even if a batch is logged for it.
select create_product(
  (select id from businesses where slug = 'expiry-test-shop-x'),
  'Test Never Stocked', null, null, 'each', 'standard',
  '{}'::text[],
  '[{"sku": "NEVER-STOCKED", "barcode": "", "variant_options": {}, "cost_price": 1, "selling_price": 2}]'::jsonb
);
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001101';
select register_business('Expiry Test Shop Y', 'Yaw', 'Darko');
reset role;
reset request.jwt.claim.sub;

create table ie_ids as
select
  (select id from businesses where slug = 'expiry-test-shop-x') as biz_x,
  (select id from businesses where slug = 'expiry-test-shop-y') as biz_y,
  (select b.id from branches b where b.business_id = (select id from businesses where slug = 'expiry-test-shop-x') and b.is_main) as branch_x,
  (select b.id from branches b where b.business_id = (select id from businesses where slug = 'expiry-test-shop-y') and b.is_main) as branch_y,
  (select v.id from product_variants v where v.sku = 'YOG-500ML') as variant_x,
  (select v.id from product_variants v where v.sku = 'NEVER-STOCKED') as variant_x_unstocked;

do $$
declare r record;
begin
  select * into r from ie_ids;
  if r.biz_x is null or r.biz_y is null or r.branch_x is null or r.branch_y is null or r.variant_x is null or r.variant_x_unstocked is null then
    raise exception 'TEST FIXTURE BROKEN: ie_ids has a null — register_business()/create_product() did not produce the expected rows' using errcode = 'ZZ999';
  end if;
end $$;

grant select on ie_ids to authenticated;

-- Bootstrap a Cashier in shop X directly (not via invite), same pattern
-- other test files already use — Cashier has inventory.view but neither
-- inventory.receive nor inventory.adjust (0011's seed_default_roles_for_business).
do $$
declare v_biz uuid; v_branch uuid; v_role uuid;
begin
  select biz_x, branch_x into v_biz, v_branch from ie_ids;
  select id into v_role from roles where business_id = v_biz and name = 'Cashier';

  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000001102', v_biz, 'Fixture', 'Cashier', 'expirycashierx@busihub.dev.example')
    on conflict (id) do nothing;

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000001102', v_role, '00000000-0000-0000-0000-000000001100')
    on conflict do nothing;
end $$;

-- Shop X's Owner receives 20 units of the tracked product, expiring in 3
-- days (within the default 7-day window) — the fixture batch used by
-- most of the tests below.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001100';

do $$
declare v_branch uuid; v_variant uuid;
begin
  select branch_x, variant_x into v_branch, v_variant from ie_ids;
  insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
    values (v_branch, v_variant, 20, 'receive');
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 1. A Cashier (inventory.view only) cannot log an expiry batch ────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001102';

do $$
declare v_branch uuid; v_variant uuid;
begin
  select branch_x, variant_x into v_branch, v_variant from ie_ids;
  begin
    insert into stock_batches (branch_id, variant_id, quantity, expiry_date)
      values (v_branch, v_variant, 20, current_date + 3);
    raise exception 'TEST FAILED: a Cashier without inventory.receive was able to log an expiry batch';
  exception
    when insufficient_privilege then
      raise notice 'PASS: a Cashier without inventory.receive cannot log an expiry batch (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 2. The Owner logs the expiry batch (happy path); the Cashier can see
-- it (inventory.view) but cannot delete it (no inventory.adjust) ────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001100';

do $$
declare v_branch uuid; v_variant uuid; v_count int;
begin
  select branch_x, variant_x into v_branch, v_variant from ie_ids;
  insert into stock_batches (branch_id, variant_id, quantity, expiry_date, note)
    values (v_branch, v_variant, 20, current_date + 3, 'Test batch');

  select count(*) into v_count from stock_batches where variant_id = v_variant and branch_id = v_branch;
  if v_count <> 1 then
    raise exception 'TEST FAILED: expected exactly 1 stock_batches row after the Owner logged one, got %', v_count using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: an Owner (inventory.receive) can log an expiry batch';
end $$;

reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001102';

do $$
declare v_variant uuid; v_count int; v_rows int;
begin
  select variant_x into v_variant from ie_ids;

  select count(*) into v_count from stock_batches where variant_id = v_variant;
  if v_count <> 1 then
    raise exception 'TEST FAILED: a Cashier with inventory.view should see the batch (got % rows)', v_count using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a Cashier with inventory.view can see the logged batch';

  delete from stock_batches where variant_id = v_variant;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'TEST FAILED: a Cashier without inventory.adjust was able to delete an expiry batch' using errcode = 'ZZ999';
  end if;
  if not exists (select 1 from stock_batches where variant_id = v_variant) then
    raise exception 'TEST FAILED: the batch is gone after a delete that should have affected 0 rows' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a Cashier without inventory.adjust cannot delete an expiry batch (RLS silently excludes it, matching the roles_delete precedent)';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 3. stock_batches has no update path at all — table grant revoked,
-- not just missing a policy ──────────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001100';

do $$
declare v_variant uuid;
begin
  select variant_x into v_variant from ie_ids;
  begin
    update stock_batches set note = 'edited' where variant_id = v_variant;
    raise exception 'TEST FAILED: stock_batches was updated despite the revoked UPDATE grant';
  exception
    when insufficient_privilege then
      raise notice 'PASS: stock_batches has no UPDATE grant at all — even the Owner cannot edit a row, only delete and re-add (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 4. Cross-tenant: shop Y sees none of shop X's batches, and cannot
-- log one against shop X's branch/variant ────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001101';

do $$
declare v_variant_x uuid; v_count int;
begin
  select variant_x into v_variant_x from ie_ids;
  select count(*) into v_count from stock_batches where variant_id = v_variant_x;
  if v_count <> 0 then
    raise exception 'TEST FAILED: shop Y can see shop X''s stock_batches rows (% rows)', v_count using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: shop Y sees none of shop X''s expiry batches';

  begin
    insert into stock_batches (branch_id, variant_id, quantity, expiry_date)
      values ((select branch_x from ie_ids), v_variant_x, 5, current_date + 1);
    raise exception 'TEST FAILED: shop Y''s Owner was able to log a batch against shop X''s branch/variant';
  exception
    when sqlstate 'P0002' then
      raise notice 'PASS: a branch id from another business is rejected as not found for the caller, not silently applied cross-tenant (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 5. expiring_stock_report() only surfaces stock that is actually on
-- hand — a batch logged for a never-received variant does not appear ────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001100';

do $$
declare v_branch uuid; v_unstocked uuid; v_count int;
begin
  select branch_x, variant_x_unstocked into v_branch, v_unstocked from ie_ids;

  insert into stock_batches (branch_id, variant_id, quantity, expiry_date)
    values (v_branch, v_unstocked, 10, current_date + 1);

  select count(*) into v_count from expiring_stock_report(null, 30, 200) where variant_id = v_unstocked;
  if v_count <> 0 then
    raise exception 'TEST FAILED: expiring_stock_report() surfaced a variant with zero stock on hand' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: expiring_stock_report() never surfaces a variant that currently has no stock on hand';
end $$;

do $$
declare v_variant uuid; v_row record;
begin
  select variant_x into v_variant from ie_ids;
  select * into v_row from expiring_stock_report(null, 7, 200) where variant_id = v_variant;
  if v_row.variant_id is null then
    raise exception 'TEST FAILED: expiring_stock_report() did not surface the stocked, soon-expiring batch' using errcode = 'ZZ999';
  end if;
  if v_row.severity <> 'warning' then
    raise exception 'TEST FAILED: a batch expiring in 3 days should be severity=warning, got %', v_row.severity using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: expiring_stock_report() surfaces the stocked, soon-expiring batch with severity=warning';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 6. notification_feed_base() only surfaces expiring_stock once
-- track_expiry is actually turned on for that business ───────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001100';

do $$
declare v_count int;
begin
  -- track_expiry defaults to false (0002) — nothing has switched it on
  -- for this fresh business yet.
  select count(*) into v_count from notification_feed_base() where type = 'expiring_stock';
  if v_count <> 0 then
    raise exception 'TEST FAILED: expiring_stock appeared in the feed before track_expiry was turned on' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: no expiring_stock alert while track_expiry is off, even with a soon-expiring batch on record';
end $$;

do $$
declare v_biz uuid; v_count int; v_key text;
begin
  select biz_x into v_biz from ie_ids;
  update business_settings
    set inventory_settings = jsonb_set(inventory_settings, '{track_expiry}', 'true')
    where business_id = v_biz;

  select count(*), min(dismissal_key) into v_count, v_key from notification_feed_base() where type = 'expiring_stock';
  if v_count <> 1 then
    raise exception 'TEST FAILED: expected exactly 1 expiring_stock alert once track_expiry is on, got %', v_count using errcode = 'ZZ999';
  end if;
  if v_key not like 'expiring_stock:%' then
    raise exception 'TEST FAILED: unexpected dismissal_key shape: %', v_key using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: turning on track_expiry makes the expiring_stock alert appear, keyed for per-user dismissal like every other alert';
end $$;

reset role;
reset request.jwt.claim.sub;

-- Shop Y never sees shop X's alert, track_expiry or not.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001101';

do $$
declare v_count int;
begin
  select count(*) into v_count from notification_feed_base() where type = 'expiring_stock';
  if v_count <> 0 then
    raise exception 'TEST FAILED: shop Y sees an expiring_stock alert that belongs to shop X' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: shop Y never sees shop X''s expiring_stock alert';
end $$;

reset role;
reset request.jwt.claim.sub;

\echo ''
\echo 'All inventory expiry (0055) tests passed.'