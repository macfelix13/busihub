-- Busihub — behaviour/security test for services (migration 0040), plus
-- service_provider_performance() (migration 0041 — see that file's
-- header for why it cannot be composed from staff_performance()).
--
-- A service is a product with type = 'service': same catalog, same till
-- search, same tax handling, same create_sale()/create_refund() — the
-- only things that differ are (a) it never touches the stock ledger and
-- (b) every sale line for one must name, and validate, who actually did
-- the work (sale_items.rendered_by), which a product line never has.
--
-- `TEST FAILED` raises carry SQLSTATE ZZ999, which no handler here catches
-- (the default, P0001/P0002/42501 are caught below as expected rejections).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────
--
-- A fresh business (so this suite doesn't depend on what earlier suites
-- left in busihub-demo-store), one Owner who can do everything, one
-- active "barber" who holds no role at all — rendered_by only ever checks
-- that a profile is an active member of the same business (any active
-- staff member, by the user's own choice — see 0040's header), never a
-- permission — and one inactive staff member to prove a departed/
-- suspended colleague cannot be named.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000700',
   'authenticated', 'authenticated', 'ownersvc@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000701',
   'authenticated', 'authenticated', 'barber1@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000702',
   'authenticated', 'authenticated', 'formerbarber@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000700';
select register_business('Services Test Salon', 'Ama', 'Boateng');
reset role;
reset request.jwt.claim.sub;

create table svc_ids as
select
  (select id from businesses where slug = 'services-test-salon') as biz,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'services-test-salon') and b.is_main) as branch;

do $$
declare r record;
begin
  select * into r from svc_ids;
  if r.biz is null or r.branch is null then
    raise exception 'TEST FIXTURE BROKEN: svc_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

grant select on svc_ids to authenticated;

-- The barber and the former barber: active staff need no role/branch
-- assignment at all to be named as a renderer (by design — see header),
-- so these are bare profile rows, not full staff members.
do $$
declare v_biz uuid;
begin
  select biz into v_biz from svc_ids;
  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email, status)
    values
      ('00000000-0000-0000-0000-000000000701', v_biz, 'Barber', 'One', 'barber1@busihub.dev.example', 'active'),
      ('00000000-0000-0000-0000-000000000702', v_biz, 'Former', 'Barber', 'formerbarber@busihub.dev.example', 'inactive')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);
end $$;

-- ── 1. Creating a service: type is recorded, opening stock is meaningless ─

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000700';

do $$
declare v_product_id uuid; v_type text; v_variant_id uuid;
begin
  -- opening_stock is sent (as a service form should never do, but nothing
  -- stops a tampered request from trying) and must be silently ignored:
  -- no branch is required, and it does not need inventory.receive either.
  select create_product(
    (select biz from svc_ids), 'Braiding', null, null, 'each', 'standard',
    '{}'::text[],
    jsonb_build_array(jsonb_build_object(
      'sku', 'BRAID-1', 'barcode', '', 'variant_options', '{}'::jsonb,
      'cost_price', 0, 'selling_price', 80, 'opening_stock', 50
    )),
    null, -- no branch given, and none should be needed
    'service'
  ) into v_product_id;

  select type into v_type from products where id = v_product_id;
  if v_type <> 'service' then
    raise exception 'TEST FAILED: expected type=service, got %', v_type using errcode = 'ZZ999';
  end if;

  select id into v_variant_id from product_variants where product_id = v_product_id and sku = 'BRAID-1';

  if exists (select 1 from inventory_movements where variant_id = v_variant_id) then
    raise exception 'TEST FAILED: a service''s opening_stock wrote an inventory movement' using errcode = 'ZZ999';
  end if;
  if exists (select 1 from stock_levels where variant_id = v_variant_id) then
    raise exception 'TEST FAILED: a service variant has a stock_levels row' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: create_product(p_type => service) records type=service and ignores opening_stock entirely';
end $$;

-- A second service, with two variants (short/long hair), the way a real
-- salon would price one service two ways — proving services get variants
-- for free, same as products.
do $$
declare v_product_id uuid; v_n int;
begin
  select create_product(
    (select biz from svc_ids), 'Dreadlocks', null, null, 'each', 'standard',
    array['Length'],
    jsonb_build_array(
      jsonb_build_object('sku', 'DREAD-S', 'barcode', '', 'variant_options', jsonb_build_object('Length', 'Short'),
        'cost_price', 0, 'selling_price', 120),
      jsonb_build_object('sku', 'DREAD-L', 'barcode', '', 'variant_options', jsonb_build_object('Length', 'Long'),
        'cost_price', 0, 'selling_price', 180)
    ),
    null, 'service'
  ) into v_product_id;

  select count(*) into v_n from product_variants where product_id = v_product_id;
  if v_n <> 2 then
    raise exception 'TEST FAILED: expected 2 variants on a service, got %', v_n using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a service can have priced variants, exactly like a product';
end $$;

-- A plain product too, for the mixed-cart test below.
select create_product(
  (select biz from svc_ids), 'Shampoo', null, null, 'each', 'standard',
  '{}'::text[],
  jsonb_build_array(jsonb_build_object(
    'sku', 'SHAMP-1', 'barcode', '', 'variant_options', '{}'::jsonb,
    'cost_price', 5, 'selling_price', 25, 'opening_stock', 10
  )),
  (select branch from svc_ids), 'product'
);

reset role;
reset request.jwt.claim.sub;

create table svc_variants as
select
  (select id from product_variants where sku = 'BRAID-1') as braiding,
  (select id from product_variants where sku = 'DREAD-S') as dreadlocks_short,
  (select id from product_variants where sku = 'SHAMP-1') as shampoo;

grant select on svc_variants to authenticated;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000700';

-- ── 2. A service line needs a renderer ────────────────────────────────────

do $$
begin
  begin
    perform create_sale(
      (select branch from svc_ids), null, null, 'cash', 80,
      jsonb_build_array(jsonb_build_object('variant_id', (select braiding from svc_variants), 'quantity', 1))
    );
    raise exception 'TEST FAILED: a service sold with no rendered_by' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a service line with no rendered_by is refused (%)', sqlerrm;
  end;

  -- An empty string (what an unselected <select> often posts) must be
  -- treated the same as absent, not as some literal "" renderer.
  begin
    perform create_sale(
      (select branch from svc_ids), null, null, 'cash', 80,
      jsonb_build_array(jsonb_build_object(
        'variant_id', (select braiding from svc_variants), 'quantity', 1, 'rendered_by', ''))
    );
    raise exception 'TEST FAILED: a blank rendered_by was accepted' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a blank rendered_by is treated the same as none';
  end;
end $$;

-- ── 3. The renderer must be a real, active member of THIS business ───────

do $$
begin
  -- Someone else's business entirely (the seeded demo store's owner).
  begin
    perform create_sale(
      (select branch from svc_ids), null, null, 'cash', 80,
      jsonb_build_array(jsonb_build_object(
        'variant_id', (select braiding from svc_variants), 'quantity', 1,
        'rendered_by', '00000000-0000-0000-0000-000000000001'))
    );
    raise exception 'TEST FAILED: attributed a service to another business''s staff' using errcode = 'ZZ999';
  exception when sqlstate 'P0002' then
    raise notice 'PASS: a renderer from another business is refused';
  end;

  -- A real member of THIS business, but inactive.
  begin
    perform create_sale(
      (select branch from svc_ids), null, null, 'cash', 80,
      jsonb_build_array(jsonb_build_object(
        'variant_id', (select braiding from svc_variants), 'quantity', 1,
        'rendered_by', '00000000-0000-0000-0000-000000000702'))
    );
    raise exception 'TEST FAILED: attributed a service to an inactive staff member' using errcode = 'ZZ999';
  exception when sqlstate 'P0002' then
    raise notice 'PASS: an inactive renderer is refused';
  end;
end $$;

-- ── 4. A valid renderer works, and no stock movement is ever written ─────

do $$
declare v_sale uuid; v_item record; v_movements int;
begin
  select create_sale(
    (select branch from svc_ids), null, null, 'cash', 80,
    jsonb_build_array(jsonb_build_object(
      'variant_id', (select braiding from svc_variants), 'quantity', 1,
      'rendered_by', '00000000-0000-0000-0000-000000000701'))
  ) into v_sale;

  select * into v_item from sale_items where sale_id = v_sale;

  if v_item.rendered_by <> '00000000-0000-0000-0000-000000000701' then
    raise exception 'TEST FAILED: rendered_by was not recorded on the sale line' using errcode = 'ZZ999';
  end if;

  select count(*) into v_movements from inventory_movements
  where reference_type = 'sale' and reference_id = v_sale;
  if v_movements <> 0 then
    raise exception 'TEST FAILED: a service sale wrote % inventory movement(s)', v_movements using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a valid renderer is recorded on the sale line, and no stock is touched';
end $$;

-- ── 5. A mixed sale: a product line and a service line together ─────────
-- The product line still needs — and gets — a real stock movement; the
-- service line still needs — and gets — no movement at all. And a
-- rendered_by sent for the PRODUCT line is simply ignored, not an error —
-- it grants nothing, so there is nothing to reject.

do $$
declare v_sale uuid; v_stock_before numeric; v_stock_after numeric; v_svc_item record; v_prod_item record;
begin
  select quantity into v_stock_before from stock_levels
  where branch_id = (select branch from svc_ids) and variant_id = (select shampoo from svc_variants);

  select create_sale(
    (select branch from svc_ids), null, null, 'cash', 1000,
    jsonb_build_array(
      jsonb_build_object('variant_id', (select shampoo from svc_variants), 'quantity', 1,
        'rendered_by', '00000000-0000-0000-0000-000000000701'), -- ignored: this is a product
      jsonb_build_object('variant_id', (select dreadlocks_short from svc_variants), 'quantity', 1,
        'rendered_by', '00000000-0000-0000-0000-000000000701')
    )
  ) into v_sale;

  select * into v_prod_item from sale_items where sale_id = v_sale and variant_id = (select shampoo from svc_variants);
  select * into v_svc_item from sale_items where sale_id = v_sale and variant_id = (select dreadlocks_short from svc_variants);

  if v_prod_item.rendered_by is not null then
    raise exception 'TEST FAILED: a product line recorded a rendered_by (%)', v_prod_item.rendered_by
      using errcode = 'ZZ999';
  end if;
  if v_svc_item.rendered_by <> '00000000-0000-0000-0000-000000000701' then
    raise exception 'TEST FAILED: the service line in a mixed sale lost its rendered_by' using errcode = 'ZZ999';
  end if;

  select quantity into v_stock_after from stock_levels
  where branch_id = (select branch from svc_ids) and variant_id = (select shampoo from svc_variants);
  if v_stock_after <> v_stock_before - 1 then
    raise exception 'TEST FAILED: the product line in a mixed sale did not take stock (% -> %)',
      v_stock_before, v_stock_after using errcode = 'ZZ999';
  end if;

  if exists (
    select 1 from inventory_movements
    where reference_type = 'sale' and reference_id = v_sale
      and variant_id = (select dreadlocks_short from svc_variants)
  ) then
    raise exception 'TEST FAILED: the service line in a mixed sale wrote a stock movement' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a mixed sale prices both lines correctly — stock moves for the product, never for the service, and rendered_by is ignored on a product line rather than rejected';
end $$;

-- ── 6. Refunding a service never restocks, whatever the client asks ──────

do $$
declare v_sale uuid; v_item_id uuid; v_refund uuid; v_movements int; v_restocked boolean;
begin
  select create_sale(
    (select branch from svc_ids), null, null, 'cash', 80,
    jsonb_build_array(jsonb_build_object(
      'variant_id', (select braiding from svc_variants), 'quantity', 1,
      'rendered_by', '00000000-0000-0000-0000-000000000701'))
  ) into v_sale;

  select id into v_item_id from sale_items where sale_id = v_sale;

  -- restock => true, exactly as a UI that forgot to hide the checkbox for
  -- a service line would send. The server must override it regardless.
  select create_refund(v_sale, null, 'cash', 'Not happy with the style',
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1, 'restock', true))
  ) into v_refund;

  select restocked into v_restocked from refund_items where refund_id = v_refund;
  if v_restocked then
    raise exception 'TEST FAILED: a service refund was recorded as restocked' using errcode = 'ZZ999';
  end if;

  select count(*) into v_movements from inventory_movements
  where reference_type = 'refund' and reference_id = v_refund;
  if v_movements <> 0 then
    raise exception 'TEST FAILED: refunding a service wrote % inventory movement(s)', v_movements using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: refunding a service is never treated as restocking, even when the client asks for it';
end $$;

-- ── 7. service_provider_performance(): revenue by renderer, not by cashier ─
--
-- Across sections 4-6 above, barber 701 rendered three service lines in
-- this business: braiding (80, kept), the dreadlocks_short line inside
-- the mixed sale (120, kept — the shampoo line's rendered_by was ignored
-- since it's a product), and a second braiding (80, fully refunded).
-- Expected: 3 lines, 280 gross, 80 refunded, 200 net. Barber 702 (never
-- named as a renderer, and inactive besides) must not appear at all.

do $$
declare v_row record; v_rows int;
begin
  select count(*) into v_rows from service_provider_performance(null, null, null, 50)
  where provider_id in ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000702');
  if v_rows <> 1 then
    raise exception 'TEST FAILED: expected exactly one renderer with figures, got %', v_rows using errcode = 'ZZ999';
  end if;

  select * into v_row from service_provider_performance(null, null, null, 50)
  where provider_id = '00000000-0000-0000-0000-000000000701';

  if v_row.service_count <> 3 or v_row.gross_total <> 280.00 or v_row.refunded_total <> 80.00
     or v_row.net_total <> 200.00 then
    raise exception 'TEST FAILED: renderer row read % lines / % gross / % back / % net',
      v_row.service_count, v_row.gross_total, v_row.refunded_total, v_row.net_total using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: service revenue is attributed per renderer, across multiple sales, with refunds netted separately';
end $$;

-- A checkout with two renderers on one sale (the exact barber-A/barber-B
-- example from 0040's own header) must split correctly per line, not
-- collapse onto whichever renderer happened to be on the first line —
-- proving this is genuinely a per-LINE report, unlike cashier-based
-- staff_performance().
do $$
declare v_sale uuid; v_a record; v_b record;
begin
  select create_sale(
    (select branch from svc_ids), null, null, 'cash', 200,
    jsonb_build_array(
      jsonb_build_object('variant_id', (select braiding from svc_variants), 'quantity', 1,
        'rendered_by', '00000000-0000-0000-0000-000000000701'),
      jsonb_build_object('variant_id', (select dreadlocks_short from svc_variants), 'quantity', 1,
        'rendered_by', '00000000-0000-0000-0000-000000000701')
    )
  ) into v_sale;

  -- Both lines above were rendered by 701 (this business has only one
  -- other real active profile besides the owner), so re-check the
  -- running total picked both up rather than merging them into one line.
  select * into v_a from service_provider_performance(null, null, null, 50)
  where provider_id = '00000000-0000-0000-0000-000000000701';

  if v_a.service_count <> 5 or v_a.gross_total <> 480.00 then
    raise exception 'TEST FAILED: a two-line service sale was not fully counted (% lines / % gross)',
      v_a.service_count, v_a.gross_total using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: every service line on a sale is counted, not just one per sale';
end $$;

-- Tenant isolation: a second business's session must see none of this.
-- The seeded demo store's owner (000...0001) already exists in auth.users
-- (supabase/seed.sql) — no fixture insert needed, and one attempted here
-- while still `set role authenticated` from above would fail anyway
-- (that role has no insert grant on auth.users, by design).
do $$
declare v_rows int;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);

  select count(*) into v_rows from service_provider_performance(null, null, null, 100)
  where provider_id in ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000702');

  if v_rows <> 0 then
    raise exception 'TEST FAILED: another business''s renderer figures were visible (% rows)', v_rows
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a second business sees none of this business''s service-provider figures';
end $$;

reset role;
reset request.jwt.claim.sub;

\echo ''
\echo 'All services tests passed.'