-- Busihub — security/behaviour test for inventory (migration 0015),
-- exercised directly against Postgres + RLS rather than through the
-- application, so a bug in a Server Action can never be the reason these
-- guarantees appear to hold.
--
-- Run against a throwaway Postgres loaded with
-- tests/db-harness/00_stub_supabase.sql + supabase/migrations/*.sql +
-- supabase/seed.sql (see tests/security/README.md).
--
-- Any `TEST FAILED` aborts the script (ON_ERROR_STOP); CI treats a
-- non-zero psql exit code as a failed build.

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────
-- Business A + its Owner (001) and Cashier (099) come from seed.sql.
-- Business B exists so cross-tenant attempts have somewhere to point.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000042',
        'authenticated', 'authenticated', 'ownerb@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000042';
select register_business('Inventory Test Shop B', 'Kofi', 'Boateng');
reset role;
reset request.jwt.claim.sub;

-- A product in business A, created by A's owner through the real RPC.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select create_product(
  (select id from businesses where slug = 'busihub-demo-store'),
  'Test Rice 5kg', null, 'Grains', 'each', 'standard',
  '{}'::text[],
  '[{"sku": "RICE-5KG", "barcode": "", "variant_options": {}, "cost_price": 40, "selling_price": 55}]'::jsonb
);
reset role;
reset request.jwt.claim.sub;

-- Handy ids for the rest of the script. A plain table rather than a
-- TEMPORARY one: the blocks below run under `set role authenticated`, and
-- a temp table owned by postgres isn't reachable from another role.
create table t_ids as
select
  -- Pinned by slug, not "whichever business isn't B": this file may run
  -- in the same database as tenant_isolation_and_rbac.sql, which creates
  -- a third business, and a `limit 1` would then be a coin flip.
  (select id from businesses where slug = 'busihub-demo-store')          as biz_a,
  (select id from businesses where slug = 'inventory-test-shop-b')       as biz_b,
  (select b.id from branches b
     where b.business_id = (select id from businesses where slug = 'busihub-demo-store')
       and b.is_main)                                                    as branch_a,
  (select b.id from branches b
     where b.business_id = (select id from businesses where slug = 'inventory-test-shop-b')
       and b.is_main)                                                    as branch_b,
  (select v.id from product_variants v where v.sku = 'RICE-5KG')         as variant_a;

-- Fail loudly if any fixture id came back null, rather than letting the
-- tests below "pass" against nulls.
do $$
declare r record;
begin
  select * into r from t_ids;
  if r.biz_a is null or r.biz_b is null or r.branch_a is null or r.branch_b is null or r.variant_a is null then
    raise exception 'TEST FIXTURE BROKEN: t_ids has a null (biz_a=%, biz_b=%, branch_a=%, branch_b=%, variant_a=%)',
      r.biz_a, r.biz_b, r.branch_a, r.branch_b, r.variant_a;
  end if;
end $$;

grant select on t_ids to authenticated;

-- A Cashier on business A (inventory.view, but neither .receive nor
-- .adjust) — the "can look but not touch" case in test 10. Created here
-- rather than assumed: seed.sql only creates the Owner.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000099',
        'authenticated', 'authenticated', 'cashier@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

do $$
declare
  v_business_id uuid;
  v_branch_id uuid;
  v_cashier_role_id uuid;
begin
  select biz_a, branch_a into v_business_id, v_branch_id from t_ids;
  select id into v_cashier_role_id from roles where business_id = v_business_id and name = 'Cashier';

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000099', v_business_id, 'Demo', 'Cashier', 'cashier@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_business_id, v_branch_id, '00000000-0000-0000-0000-000000000099',
            v_cashier_role_id, '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;

  -- Guard the fixture itself: if the Cashier role ever stops carrying
  -- inventory.view, test 10 would "pass" for the wrong reason.
  if not exists (
    select 1 from role_permissions rp
    join permissions p on p.id = rp.permission_id
    where rp.role_id = v_cashier_role_id and p.key = 'inventory.view'
  ) then
    raise exception 'TEST FIXTURE BROKEN: seeded Cashier role does not hold inventory.view';
  end if;
end $$;

-- ── 1. Receiving stock accumulates into the derived level ────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_qty numeric; v_branch uuid; v_variant uuid;
begin
  select branch_a, variant_a into v_branch, v_variant from t_ids;

  insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason, note)
  values ('00000000-0000-0000-0000-000000000000', v_branch, v_variant, 10, 'receive', 'first delivery');

  select quantity into v_qty from stock_levels where branch_id = v_branch and variant_id = v_variant;
  if v_qty is distinct from 10 then
    raise exception 'TEST FAILED: expected 10 on hand after receiving 10, got %', v_qty;
  end if;

  insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
  values ('00000000-0000-0000-0000-000000000000', v_branch, v_variant, 5, 'receive');

  select quantity into v_qty from stock_levels where branch_id = v_branch and variant_id = v_variant;
  if v_qty is distinct from 15 then
    raise exception 'TEST FAILED: expected 15 after a second receipt of 5, got %', v_qty;
  end if;

  raise notice 'PASS: receipts accumulate into stock_levels (10 then 15)';
end $$;

-- ── 2. business_id and created_by are forced, not trusted ────────────────

do $$
declare v_biz uuid; v_by uuid; v_biz_a uuid; v_biz_b uuid;
begin
  select biz_a, biz_b into v_biz_a, v_biz_b from t_ids;

  -- Deliberately claims business B and a different author.
  insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason, created_by)
  select v_biz_b, branch_a, variant_a, 1, 'receive', '00000000-0000-0000-0000-000000000099' from t_ids;

  select business_id, created_by into v_biz, v_by
  from inventory_movements order by created_at desc, id desc limit 1;

  if v_biz <> v_biz_a then
    raise exception 'TEST FAILED: spoofed business_id survived (got %, expected %)', v_biz, v_biz_a;
  end if;
  if v_by <> '00000000-0000-0000-0000-000000000001' then
    raise exception 'TEST FAILED: spoofed created_by survived (got %)', v_by;
  end if;

  raise notice 'PASS: business_id and created_by are overwritten from branch/session';
end $$;

-- ── 3. Stock cannot be driven negative by a manual adjustment ────────────

do $$
declare v_qty_before numeric; v_qty_after numeric; v_branch uuid; v_variant uuid;
begin
  select branch_a, variant_a into v_branch, v_variant from t_ids;
  select quantity into v_qty_before from stock_levels where branch_id = v_branch and variant_id = v_variant;

  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason, note)
    values ('00000000-0000-0000-0000-000000000000', v_branch, v_variant, -1000, 'adjustment', 'oops');
    raise exception 'TEST FAILED: an adjustment drove stock negative without being rejected';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: negative-stock adjustment rejected (%)', sqlerrm;
  end;

  select quantity into v_qty_after from stock_levels where branch_id = v_branch and variant_id = v_variant;
  if v_qty_after is distinct from v_qty_before then
    raise exception 'TEST FAILED: rejected adjustment still changed stock (% -> %)', v_qty_before, v_qty_after;
  end if;

  raise notice 'PASS: rejected adjustment left stock unchanged at %', v_qty_after;
end $$;

-- ── 4. A zero delta is refused by the check constraint ───────────────────

do $$
begin
  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
    select '00000000-0000-0000-0000-000000000000', branch_a, variant_a, 0, 'adjustment' from t_ids;
    raise exception 'TEST FAILED: a zero-quantity movement was accepted';
  exception
    when check_violation then
      raise notice 'PASS: zero-quantity movement rejected by check constraint';
  end;
end $$;

-- ── 5. record_stock_count(): absolute count becomes the right delta ──────

do $$
declare v_movement uuid; v_qty numeric; v_delta numeric; v_branch uuid; v_variant uuid;
begin
  select branch_a, variant_a into v_branch, v_variant from t_ids;
  -- Stock is 16 here (10 + 5 + the 1 from the spoofing test).

  select record_stock_count(v_branch, v_variant, 20, 'monthly count') into v_movement;
  if v_movement is null then
    raise exception 'TEST FAILED: counting 20 against 16 should have recorded a movement';
  end if;

  select quantity_delta into v_delta from inventory_movements where id = v_movement;
  if v_delta is distinct from 4 then
    raise exception 'TEST FAILED: expected a +4 delta counting 20 against 16, got %', v_delta;
  end if;

  select quantity into v_qty from stock_levels where branch_id = v_branch and variant_id = v_variant;
  if v_qty is distinct from 20 then
    raise exception 'TEST FAILED: stock should be 20 after the count, got %', v_qty;
  end if;

  -- Counting the same number again is a no-op, not an error and not a row.
  select record_stock_count(v_branch, v_variant, 20, 'again') into v_movement;
  if v_movement is not null then
    raise exception 'TEST FAILED: a count matching current stock recorded a movement';
  end if;

  raise notice 'PASS: record_stock_count computes the delta (+4 -> 20) and no-ops when it matches';
end $$;

-- ── 6. A count can take stock to zero, but not below ─────────────────────

do $$
begin
  begin
    perform record_stock_count((select branch_a from t_ids), (select variant_a from t_ids), -5, null);
    raise exception 'TEST FAILED: a negative counted quantity was accepted';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: negative counted quantity rejected';
  end;
end $$;

-- ── 7. Reasons reserved for later phases are not insertable ──────────────

do $$
begin
  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
    select '00000000-0000-0000-0000-000000000000', branch_a, variant_a, -1, 'sale' from t_ids;
    raise exception 'TEST FAILED: a "sale" movement was insertable before the sales phase exists';
  exception
    when insufficient_privilege then
      raise notice 'PASS: reserved reason "sale" rejected by RLS';
  end;

  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
    select '00000000-0000-0000-0000-000000000000', branch_a, variant_a, -1, 'transfer_out' from t_ids;
    raise exception 'TEST FAILED: a "transfer_out" movement was insertable before the transfers phase exists';
  exception
    when insufficient_privilege then
      raise notice 'PASS: reserved reason "transfer_out" rejected by RLS';
  end;
end $$;

-- ── 8. stock_levels is not directly writable, even by the Owner ──────────

do $$
begin
  begin
    update stock_levels set quantity = 9999
    where branch_id = (select branch_a from t_ids);
    raise exception 'TEST FAILED: stock_levels was directly UPDATEable';
  exception
    when insufficient_privilege then
      raise notice 'PASS: direct UPDATE on stock_levels refused (no grant)';
  end;

  begin
    insert into stock_levels (business_id, branch_id, variant_id, quantity)
    select biz_a, branch_a, variant_a, 9999 from t_ids;
    raise exception 'TEST FAILED: stock_levels was directly INSERTable';
  exception
    when insufficient_privilege then
      raise notice 'PASS: direct INSERT on stock_levels refused (no grant)';
  end;

  begin
    delete from stock_levels where branch_id = (select branch_a from t_ids);
    raise exception 'TEST FAILED: stock_levels rows were directly DELETEable';
  exception
    when insufficient_privilege then
      raise notice 'PASS: direct DELETE on stock_levels refused (no grant)';
  end;
end $$;

-- ── 9. The ledger is append-only ─────────────────────────────────────────

do $$
begin
  begin
    update inventory_movements set quantity_delta = 1;
    raise exception 'TEST FAILED: an inventory_movements row was UPDATEable';
  exception
    when insufficient_privilege then
      raise notice 'PASS: UPDATE on inventory_movements refused (grant revoked)';
  end;

  begin
    delete from inventory_movements;
    raise exception 'TEST FAILED: an inventory_movements row was DELETEable';
  exception
    when insufficient_privilege then
      raise notice 'PASS: DELETE on inventory_movements refused (grant revoked)';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 10. A Cashier can look but not touch ─────────────────────────────────
-- The seeded Cashier holds inventory.view but neither .receive nor .adjust.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000099';

do $$
declare v_visible int;
begin
  select count(*) into v_visible from stock_levels;
  if v_visible < 1 then
    raise exception 'TEST FAILED: cashier holds inventory.view but saw no stock levels';
  end if;

  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
    select '00000000-0000-0000-0000-000000000000', branch_a, variant_a, 5, 'receive' from t_ids;
    raise exception 'TEST FAILED: cashier received stock without inventory.receive';
  exception
    when insufficient_privilege then
      raise notice 'PASS: cashier blocked from receiving stock';
  end;

  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
    select '00000000-0000-0000-0000-000000000000', branch_a, variant_a, -5, 'adjustment' from t_ids;
    raise exception 'TEST FAILED: cashier adjusted stock without inventory.adjust';
  exception
    when insufficient_privilege then
      raise notice 'PASS: cashier blocked from adjusting stock';
  end;

  begin
    perform record_stock_count((select branch_a from t_ids), (select variant_a from t_ids), 3, null);
    raise exception 'TEST FAILED: cashier recorded a stock count without inventory.adjust';
  exception
    when insufficient_privilege then
      raise notice 'PASS: cashier blocked from recording a stock count';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 11. Cross-tenant isolation ───────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000042';

do $$
declare v_seen int;
begin
  select count(*) into v_seen from stock_levels;
  if v_seen <> 0 then
    raise exception 'TEST FAILED: business B owner saw % of business A''s stock rows', v_seen;
  end if;

  select count(*) into v_seen from inventory_movements;
  if v_seen <> 0 then
    raise exception 'TEST FAILED: business B owner saw % of business A''s movements', v_seen;
  end if;

  raise notice 'PASS: business B owner sees none of business A''s inventory';

  -- Pointing a movement at business A's branch/variant: those rows are
  -- invisible to this session, so the context trigger reports them as
  -- not found rather than leaking their existence.
  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
    select biz_b, branch_a, variant_a, 100, 'receive' from t_ids;
    raise exception 'TEST FAILED: business B owner wrote a movement against business A stock';
  exception
    when sqlstate 'P0002' then
      raise notice 'PASS: cross-tenant movement rejected (branch/variant not visible)';
    when insufficient_privilege then
      raise notice 'PASS: cross-tenant movement rejected by RLS';
  end;

  -- Own branch, but another tenant's product.
  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
    select biz_b, branch_b, variant_a, 100, 'receive' from t_ids;
    raise exception 'TEST FAILED: business B owner stocked business A''s product into their own branch';
  exception
    when sqlstate 'P0002' then
      raise notice 'PASS: foreign variant rejected (not visible to this tenant)';
    when sqlstate 'P0001' then
      raise notice 'PASS: foreign variant rejected (business mismatch)';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 12. The ledger still reconciles to the derived level ─────────────────
-- The real invariant behind this whole design: stock_levels must always
-- equal the sum of the movements that produced it.

do $$
declare v_mismatches int;
begin
  select count(*) into v_mismatches
  from stock_levels s
  where s.quantity is distinct from (
    select coalesce(sum(m.quantity_delta), 0)
    from inventory_movements m
    where m.branch_id = s.branch_id and m.variant_id = s.variant_id
  );

  if v_mismatches <> 0 then
    raise exception 'TEST FAILED: % stock_levels row(s) disagree with their movement history', v_mismatches;
  end if;

  raise notice 'PASS: every stock level reconciles exactly to its movement ledger';
end $$;

\echo ''
\echo 'All inventory tests passed.'
