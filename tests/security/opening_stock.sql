-- Busihub — behaviour/security test for opening stock (migration 0026).
--
-- Adding a product can now put stock on the shelf in the same breath.
-- That is a convenience, and conveniences around stock are exactly where
-- audit trails get quietly lost — so these assertions are mostly about
-- what did NOT change: the movement is a real ledger row, it still needs
-- inventory.receive, and a product that fails to save takes its stock
-- with it.
--
-- `TEST FAILED` raises carry SQLSTATE ZZ999, which no handler catches.

\set ON_ERROR_STOP on
\pset format aligned

create table os_ids as
select
  (select id from businesses where slug = 'busihub-demo-store') as biz_a,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'busihub-demo-store') and b.is_main) as branch_a,
  (select id from businesses where slug <> 'busihub-demo-store' limit 1) as biz_b,
  (select b.id from branches b where b.business_id <>
     (select id from businesses where slug = 'busihub-demo-store') limit 1) as branch_b,
  '00000000-0000-0000-0000-000000000001'::uuid as owner_a;

do $$
declare r record;
begin
  select * into r from os_ids;
  if r.biz_a is null or r.branch_a is null then
    raise exception 'TEST FIXTURE BROKEN: os_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

grant select on os_ids to authenticated;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

-- ── 1. Opening stock lands, through the ledger ──────────────────────────

do $$
declare v_product uuid; v_variant uuid; v_level numeric; v_move record;
begin
  select create_product(
    (select biz_a from os_ids), 'Opening Stock Rice', null, 'Grains', 'each', 'standard',
    '{}'::text[],
    jsonb_build_array(jsonb_build_object(
      'sku', 'OSRICE-1', 'barcode', '', 'variant_options', '{}'::jsonb,
      'cost_price', 30, 'selling_price', 60, 'opening_stock', 40)),
    (select branch_a from os_ids)
  ) into v_product;

  select id into v_variant from product_variants where sku = 'OSRICE-1';

  select quantity into v_level from stock_levels
  where branch_id = (select branch_a from os_ids) and variant_id = v_variant;
  if v_level is distinct from 40 then
    raise exception 'TEST FAILED: expected 40 in stock, got %', v_level using errcode = 'ZZ999';
  end if;

  -- The point of the whole design: it is a movement, not a written level.
  select * into v_move from inventory_movements where variant_id = v_variant;
  if v_move.id is null then
    raise exception 'TEST FAILED: opening stock left no ledger row' using errcode = 'ZZ999';
  end if;
  if v_move.reason <> 'receive' then
    raise exception 'TEST FAILED: opening stock recorded as %, expected receive', v_move.reason
      using errcode = 'ZZ999';
  end if;
  if v_move.created_by is distinct from '00000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'TEST FAILED: the movement does not say who did it' using errcode = 'ZZ999';
  end if;
  if v_move.business_id is distinct from (select biz_a from os_ids) then
    raise exception 'TEST FAILED: the movement has the wrong business' using errcode = 'ZZ999';
  end if;
  if v_move.reference_id is distinct from v_product then
    raise exception 'TEST FAILED: the movement does not point back at the product' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: opening stock arrives as an auditable receive movement';
end $$;

-- ── 2. A product with no opening stock behaves exactly as before ────────

do $$
declare v_product uuid; v_variant uuid; v_count int;
begin
  -- The eight-argument call: the seed, the older tests, and any code
  -- written before 0026. It must still work and must not invent stock.
  select create_product(
    (select biz_a from os_ids), 'No Opening Stock Sugar', null, 'Grains', 'each', 'standard',
    '{}'::text[],
    jsonb_build_array(jsonb_build_object(
      'sku', 'OSSUG-1', 'barcode', '', 'variant_options', '{}'::jsonb,
      'cost_price', 10, 'selling_price', 20))
  ) into v_product;

  select id into v_variant from product_variants where sku = 'OSSUG-1';
  select count(*) into v_count from inventory_movements where variant_id = v_variant;
  if v_count <> 0 then
    raise exception 'TEST FAILED: a product with no opening stock created % movement(s)', v_count
      using errcode = 'ZZ999';
  end if;
  if exists (select 1 from stock_levels where variant_id = v_variant) then
    raise exception 'TEST FAILED: a product with no opening stock has a stock level' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: the old eight-argument call still works and invents no stock';
end $$;

-- ── 3. Zero, absent, and an explicit JSON null all mean "none" ──────────
--
-- The till taught us this one: JSON.stringify writes `"opening_stock":
-- null` for an empty box, and in PostgreSQL that is not SQL NULL. All
-- three spellings must mean the same thing, and none of them may demand a
-- branch.

do $$
declare v_variant uuid; v_count int;
begin
  perform create_product(
    (select biz_a from os_ids), 'Explicit Null Stock', null, 'Grains', 'each', 'standard',
    '{}'::text[],
    jsonb_build_array(jsonb_build_object(
      'sku', 'OSNULL-1', 'barcode', '', 'variant_options', '{}'::jsonb,
      'cost_price', 1, 'selling_price', 2, 'opening_stock', null))
  );
  select id into v_variant from product_variants where sku = 'OSNULL-1';
  select count(*) into v_count from inventory_movements where variant_id = v_variant;
  if v_count <> 0 then
    raise exception 'TEST FAILED: an explicit null opening stock created a movement' using errcode = 'ZZ999';
  end if;

  perform create_product(
    (select biz_a from os_ids), 'Zero Stock', null, 'Grains', 'each', 'standard',
    '{}'::text[],
    jsonb_build_array(jsonb_build_object(
      'sku', 'OSZERO-1', 'barcode', '', 'variant_options', '{}'::jsonb,
      'cost_price', 1, 'selling_price', 2, 'opening_stock', 0))
  );
  select id into v_variant from product_variants where sku = 'OSZERO-1';
  select count(*) into v_count from inventory_movements where variant_id = v_variant;
  if v_count <> 0 then
    raise exception 'TEST FAILED: a zero opening stock created a movement' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: zero, absent and explicit null opening stock all mean none, and need no branch';
end $$;

-- ── 4. Stock without a branch is refused, and nothing is left behind ────

do $$
declare v_products int; v_variants int;
begin
  select count(*) into v_products from products;
  select count(*) into v_variants from product_variants;

  begin
    perform create_product(
      (select biz_a from os_ids), 'Homeless Stock', null, 'Grains', 'each', 'standard',
      '{}'::text[],
      jsonb_build_array(jsonb_build_object(
        'sku', 'OSHOME-1', 'barcode', '', 'variant_options', '{}'::jsonb,
        'cost_price', 1, 'selling_price', 2, 'opening_stock', 5)));
    raise exception 'TEST FAILED: opening stock was accepted with no branch' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: opening stock with no branch is refused (%)', sqlerrm;
  end;

  -- The whole thing is one transaction: a refused product leaves nothing.
  if (select count(*) from products) <> v_products then
    raise exception 'TEST FAILED: the refused product was created anyway' using errcode = 'ZZ999';
  end if;
  if (select count(*) from product_variants) <> v_variants then
    raise exception 'TEST FAILED: the refused product left variants behind' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a refused product leaves no product, variant or movement behind';
end $$;

-- ── 5. Negative opening stock is not an adjustment ──────────────────────

do $$
begin
  begin
    perform create_product(
      (select biz_a from os_ids), 'Negative Stock', null, 'Grains', 'each', 'standard',
      '{}'::text[],
      jsonb_build_array(jsonb_build_object(
        'sku', 'OSNEG-1', 'barcode', '', 'variant_options', '{}'::jsonb,
        'cost_price', 1, 'selling_price', 2, 'opening_stock', -5)),
      (select branch_a from os_ids));
    raise exception 'TEST FAILED: negative opening stock was accepted' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: negative opening stock is refused (%)', sqlerrm;
  end;
end $$;

-- ── 6. Another business's branch is not a place to put stock ───────────

do $$
declare v_branch_b uuid;
begin
  select branch_b into v_branch_b from os_ids;
  if v_branch_b is null then
    raise exception 'TEST FIXTURE BROKEN: the seed has only one business' using errcode = 'ZZ999';
  end if;

  begin
    perform create_product(
      (select biz_a from os_ids), 'Cross Tenant Stock', null, 'Grains', 'each', 'standard',
      '{}'::text[],
      jsonb_build_array(jsonb_build_object(
        'sku', 'OSXT-1', 'barcode', '', 'variant_options', '{}'::jsonb,
        'cost_price', 1, 'selling_price', 2, 'opening_stock', 5)),
      v_branch_b);
    raise exception 'TEST FAILED: stock was received into another business''s branch' using errcode = 'ZZ999';
  exception when sqlstate 'P0002' then
    raise notice 'PASS: a branch belonging to another business is refused (%)', sqlerrm;
  end;
end $$;

-- ── 7. Adding products does not become a way to receive stock ───────────
--
-- The Cashier role holds sales.process and nothing about inventory. If
-- create_product could write movements on its behalf, opening stock would
-- be a side door around inventory.receive.

reset role;
reset request.jwt.claim.sub;

do $$
declare v_biz uuid; v_branch uuid; v_role uuid;
begin
  select biz_a, branch_a into v_biz, v_branch from os_ids;
  select id into v_role from roles where business_id = v_biz and name = 'Cashier';

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000096', v_biz, 'Stock', 'Tester',
            'stocktester@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000000096', v_role,
            '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;

  if exists (
    select 1 from role_permissions rp join permissions p on p.id = rp.permission_id
    where rp.role_id = v_role and p.key = 'inventory.receive'
  ) then
    raise exception 'TEST FIXTURE BROKEN: Cashier unexpectedly holds inventory.receive' using errcode = 'ZZ999';
  end if;
end $$;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000096',
        'authenticated', 'authenticated', 'stocktester@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000096';

do $$
declare v_products int;
begin
  select count(*) into v_products from products;
  begin
    perform create_product(
      (select biz_a from os_ids), 'Cashier Stock', null, 'Grains', 'each', 'standard',
      '{}'::text[],
      jsonb_build_array(jsonb_build_object(
        'sku', 'OSCASH-1', 'barcode', '', 'variant_options', '{}'::jsonb,
        'cost_price', 1, 'selling_price', 2, 'opening_stock', 5)),
      (select branch_a from os_ids));
    raise exception 'TEST FAILED: a cashier received stock through the product form' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: opening stock still needs inventory.receive — it is not a side door';
  end;

  if (select count(*) from products) <> v_products then
    raise exception 'TEST FAILED: the refused product was created anyway' using errcode = 'ZZ999';
  end if;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 8. Everything reconciles ────────────────────────────────────────────

do $$
declare v_mismatch int;
begin
  select count(*) into v_mismatch from stock_levels s
  where s.quantity is distinct from (
    select coalesce(sum(m.quantity_delta), 0) from inventory_movements m
    where m.branch_id = s.branch_id and m.variant_id = s.variant_id);

  if v_mismatch <> 0 then
    raise exception 'TEST FAILED: % stock level(s) disagree with the ledger', v_mismatch using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: every stock level still equals the sum of its movements';
end $$;

\echo ''
\echo 'All opening stock tests passed.'
