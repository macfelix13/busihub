-- Busihub — security/correctness tests for the product/service report
-- split (migration 0056).
--
-- Two things matter here, both exercised directly against Postgres + RLS,
-- same approach as every other file in this directory:
--
--   1. CORRECTNESS OF THE SPLIT. A mixed sale (one product line, one
--      service line, rung up together) is the case the whole migration
--      exists for. sales_summary('product') + sales_summary('service')
--      must add back up to the unfiltered sales_summary(null) on every
--      money column, even though a mixed sale is counted once in each
--      side (that double-count in sale_count is deliberate, not a bug —
--      asserted explicitly below).
--
--   2. THE UNFILTERED PATH DID NOT MOVE. Every *_test.sql file that ran
--      before this one in CI order already exercised sales_summary(),
--      sales_trend() and top_products() with real fixture data and no
--      p_type argument — dashboard.sql and reports.sql already re-ran
--      clean against 0056 by the time this file runs, which is itself
--      the strongest evidence the unfiltered branch is untouched. This
--      file adds one more explicit check of its own (comparing an
--      unfiltered call against the sum of the two filtered calls) rather
--      than re-deriving that from scratch.
--
-- 12xx block: not used by any other tests/security/*.sql file (checked).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures: a business with one product and one service, plus a
-- second, unrelated business to prove cross-tenant isolation ────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001200', 'authenticated', 'authenticated', 'reportsplitownerx@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001201', 'authenticated', 'authenticated', 'reportsplitownery@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001200';
select register_business('Report Split Shop X', 'Kwabena', 'Owusu');

-- Both variants are tax_category 'exempt' so line_total = unit_price *
-- quantity exactly, with no VAT arithmetic to replicate here — the point
-- of this file is the product/service split, not the tax engine (already
-- covered elsewhere).
select create_product(
  p_business_id => (select id from businesses where slug = 'report-split-shop-x'),
  p_name => 'Test Widget',
  p_description => null,
  p_category_id => null,
  p_unit_of_measure => 'each',
  p_tax_category => 'exempt',
  p_variant_option_names => '{}'::text[],
  p_variants => '[{"sku": "RSPLIT-WIDGET", "barcode": "", "variant_options": {}, "cost_price": 10, "selling_price": 20}]'::jsonb
);
select create_product(
  p_business_id => (select id from businesses where slug = 'report-split-shop-x'),
  p_name => 'Test Haircut',
  p_description => null,
  p_category_id => null,
  p_unit_of_measure => 'each',
  p_tax_category => 'exempt',
  p_variant_option_names => '{}'::text[],
  p_variants => '[{"sku": "RSPLIT-HAIRCUT", "barcode": "", "variant_options": {}, "cost_price": 5, "selling_price": 30}]'::jsonb,
  p_type => 'service'
);
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001201';
select register_business('Report Split Shop Y', 'Abena', 'Mensah');
reset role;
reset request.jwt.claim.sub;

create table rts_ids as
select
  (select id from businesses where slug = 'report-split-shop-x') as biz_x,
  (select id from businesses where slug = 'report-split-shop-y') as biz_y,
  (select b.id from branches b where b.business_id = (select id from businesses where slug = 'report-split-shop-x') and b.is_main) as branch_x,
  (select v.id from product_variants v where v.sku = 'RSPLIT-WIDGET') as widget,
  (select v.id from product_variants v where v.sku = 'RSPLIT-HAIRCUT') as haircut;

do $$
declare r record;
begin
  select * into r from rts_ids;
  if r.biz_x is null or r.biz_y is null or r.branch_x is null or r.widget is null or r.haircut is null then
    raise exception 'TEST FIXTURE BROKEN: rts_ids has a null — register_business()/create_product() did not produce the expected rows' using errcode = 'ZZ999';
  end if;
end $$;

grant select on rts_ids to authenticated;

-- Stock the widget directly (same shortcut tests/security/inventory_expiry.sql
-- uses) — the point of this file is the reports, not receiving.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001200';

do $$
declare v_branch uuid; v_variant uuid;
begin
  select branch_x, widget into v_branch, v_variant from rts_ids;
  insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
    values (v_branch, v_variant, 10, 'receive');
end $$;

-- ── three sales: mixed, product-only, service-only ───────────────────────
--
-- Sale 1 (mixed): 2 widgets (GHS 40) + 1 haircut (GHS 30) in one checkout
-- — exactly the case sales.total cannot be split by type on its own.
-- Sale 2 (product only): 1 widget (GHS 20).
-- Sale 3 (service only): 1 haircut (GHS 30).
--
-- Expected, hand-computed totals (tax-exempt, so line_total = price * qty):
--   product : gross 60 (40+20), cost 30 (3 * 10), items 3
--   service : gross 60 (30+30), cost 10 (2 * 5),  items 2
--   combined: gross 120, cost 40, items 5 — each column is exactly the
--   sum of the two type-scoped columns, since every line is one or the
--   other and nothing is double-counted at the MONEY level.

-- One do-block for all three sales plus the refund: rts_ids/rts_sales-style
-- helper tables need CREATE on schema public, which the authenticated
-- role doesn't have (only postgres, outside this role, created rts_ids
-- above) — a do block just calls functions, which this role can already
-- do, so everything that needs auth.uid() to resolve as this owner stays
-- in local variables inside one block instead.
do $$
declare v_sale_mixed uuid; v_sale_product uuid; v_sale_service uuid; v_item_id uuid;
begin
  select create_sale(
    (select branch_x from rts_ids), null, null, 'cash', 70,
    jsonb_build_array(
      jsonb_build_object('variant_id', (select widget from rts_ids), 'quantity', 2),
      jsonb_build_object('variant_id', (select haircut from rts_ids), 'quantity', 1,
        'rendered_by', '00000000-0000-0000-0000-000000001200')
    )
  ) into v_sale_mixed;

  select create_sale(
    (select branch_x from rts_ids), null, null, 'cash', 20,
    jsonb_build_array(
      jsonb_build_object('variant_id', (select widget from rts_ids), 'quantity', 1)
    )
  ) into v_sale_product;

  select create_sale(
    (select branch_x from rts_ids), null, null, 'cash', 30,
    jsonb_build_array(
      jsonb_build_object('variant_id', (select haircut from rts_ids), 'quantity', 1,
        'rendered_by', '00000000-0000-0000-0000-000000001200')
    )
  ) into v_sale_service;

  -- Refund 1 widget from the mixed sale (GHS 20 back, restocked) — proves
  -- a refund on the PRODUCT line of a mixed sale is subtracted from the
  -- product side only, never touching the service side of that same sale.
  select id into v_item_id from sale_items where sale_id = v_sale_mixed and variant_id = (select widget from rts_ids);
  perform create_refund(v_sale_mixed, null, 'cash', 'Test refund', jsonb_build_array(
    jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1, 'restock', true)
  ));
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 1. sales_summary(): product and service figures, and that they add
-- back up to the unfiltered totals ───────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001200';

do $$
declare v_product record; v_service record; v_all record;
begin
  select * into v_product from sales_summary(null, null, null, (select branch_x from rts_ids), 'product');
  select * into v_service from sales_summary(null, null, null, (select branch_x from rts_ids), 'service');
  select * into v_all from sales_summary(null, null, null, (select branch_x from rts_ids), null);

  if v_product.gross_total <> 60 or v_product.refunded_total <> 20 or v_product.net_total <> 40
     or v_product.cost_total <> 20 or v_product.items_sold <> 3 then
    raise exception 'TEST FAILED: product-scoped sales_summary read gross=%, refunded=%, net=%, cost=%, items=% (expected 60/20/40/20/3)',
      v_product.gross_total, v_product.refunded_total, v_product.net_total, v_product.cost_total, v_product.items_sold
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: product-scoped sales_summary matches hand-computed totals (gross 60, refunded 20, net 40, cost 20, 3 items)';

  if v_service.gross_total <> 60 or v_service.refunded_total <> 0 or v_service.net_total <> 60
     or v_service.cost_total <> 10 or v_service.items_sold <> 2 then
    raise exception 'TEST FAILED: service-scoped sales_summary read gross=%, refunded=%, net=%, cost=%, items=% (expected 60/0/60/10/2)',
      v_service.gross_total, v_service.refunded_total, v_service.net_total, v_service.cost_total, v_service.items_sold
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: service-scoped sales_summary matches hand-computed totals (gross 60, refunded 0, net 60, cost 10, 2 items)';

  -- The invariant that matters most: every money column on the combined
  -- report is exactly the sum of the same column on the two split
  -- reports, because every line belongs to exactly one type.
  if v_all.gross_total <> v_product.gross_total + v_service.gross_total
     or v_all.refunded_total <> v_product.refunded_total + v_service.refunded_total
     or v_all.net_total <> v_product.net_total + v_service.net_total
     or v_all.cost_total <> v_product.cost_total + v_service.cost_total
     or v_all.gross_profit <> v_product.gross_profit + v_service.gross_profit
     or v_all.items_sold <> v_product.items_sold + v_service.items_sold then
    raise exception 'TEST FAILED: product + service sales_summary does not add back up to the unfiltered totals' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: product-scoped + service-scoped sales_summary adds back up to the unfiltered call on every money column';

  -- sale_count is the one column that deliberately does NOT add up: the
  -- mixed sale is counted once on each side.
  if v_product.sale_count <> 2 or v_service.sale_count <> 2 or v_all.sale_count <> 3 then
    raise exception 'TEST FAILED: expected sale_count product=2, service=2, combined=3 (mixed sale counted once per side), got %/%/%',
      v_product.sale_count, v_service.sale_count, v_all.sale_count using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: sale_count is 2 (product) and 2 (service) against 3 combined — the mixed sale double-counts by design, exactly as documented';
end $$;

-- ── 2. An unknown p_type is rejected, not silently treated as "both" ────

do $$
begin
  begin
    perform sales_summary(null, null, null, (select branch_x from rts_ids), 'bogus');
    raise exception 'TEST FAILED: sales_summary accepted an unknown p_type';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: sales_summary rejects an unknown p_type (%)', sqlerrm;
  end;
  begin
    perform sales_trend(now() - interval '1 day', now(), (select branch_x from rts_ids), 'day', 'Africa/Accra', 'bogus');
    raise exception 'TEST FAILED: sales_trend accepted an unknown p_type';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: sales_trend rejects an unknown p_type (%)', sqlerrm;
  end;
end $$;

-- ── 3. sales_trend(): bucketed sums agree with sales_summary() over the
-- same window, per type ───────────────────────────────────────────────────

do $$
declare v_trend_net numeric; v_summary record;
begin
  select coalesce(sum(net_total), 0) into v_trend_net
  from sales_trend(now() - interval '1 day', now() + interval '1 day', (select branch_x from rts_ids), 'day', 'Africa/Accra', 'product');
  select * into v_summary from sales_summary(now() - interval '1 day', now() + interval '1 day', null, (select branch_x from rts_ids), 'product');

  if v_trend_net <> v_summary.net_total then
    raise exception 'TEST FAILED: product-scoped sales_trend (net %) disagrees with product-scoped sales_summary (net %) over the same window',
      v_trend_net, v_summary.net_total using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: product-scoped sales_trend sums to the same net total as product-scoped sales_summary';
end $$;

do $$
declare v_trend_net numeric; v_summary record;
begin
  select coalesce(sum(net_total), 0) into v_trend_net
  from sales_trend(now() - interval '1 day', now() + interval '1 day', (select branch_x from rts_ids), 'day', 'Africa/Accra', 'service');
  select * into v_summary from sales_summary(now() - interval '1 day', now() + interval '1 day', null, (select branch_x from rts_ids), 'service');

  if v_trend_net <> v_summary.net_total then
    raise exception 'TEST FAILED: service-scoped sales_trend (net %) disagrees with service-scoped sales_summary (net %) over the same window',
      v_trend_net, v_summary.net_total using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: service-scoped sales_trend sums to the same net total as service-scoped sales_summary';
end $$;

-- ── 4. top_products(): p_type filters to exactly the matching variant ───

do $$
declare v_count int; v_row record;
begin
  select count(*) into v_count from top_products(null, null, (select branch_x from rts_ids), 10, 'product');
  if v_count <> 1 then
    raise exception 'TEST FAILED: expected exactly 1 product-type row from top_products, got %', v_count using errcode = 'ZZ999';
  end if;
  select * into v_row from top_products(null, null, (select branch_x from rts_ids), 10, 'product') limit 1;
  if v_row.variant_id <> (select widget from rts_ids) or v_row.revenue <> 40 then
    raise exception 'TEST FAILED: product-type top_products returned variant=%, revenue=% (expected the widget, revenue 40 net of the refund)',
      v_row.variant_id, v_row.revenue using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: top_products(p_type=product) returns only the widget, net of its refund';

  select count(*) into v_count from top_products(null, null, (select branch_x from rts_ids), 10, 'service');
  if v_count <> 1 then
    raise exception 'TEST FAILED: expected exactly 1 service-type row from top_products, got %', v_count using errcode = 'ZZ999';
  end if;
  select * into v_row from top_products(null, null, (select branch_x from rts_ids), 10, 'service') limit 1;
  if v_row.variant_id <> (select haircut from rts_ids) or v_row.revenue <> 60 then
    raise exception 'TEST FAILED: service-type top_products returned variant=%, revenue=% (expected the haircut, revenue 60)',
      v_row.variant_id, v_row.revenue using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: top_products(p_type=service) returns only the haircut';

  select count(*) into v_count from top_products(null, null, (select branch_x from rts_ids), 10, null);
  if v_count <> 2 then
    raise exception 'TEST FAILED: expected 2 rows from top_products with no type filter, got %', v_count using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: top_products with no p_type still returns both the widget and the haircut, unchanged';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 5. Cross-tenant: shop Y's type-scoped reports see none of shop X's
-- activity ───────────────────────────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001201';

do $$
declare v_summary record; v_count int;
begin
  select * into v_summary from sales_summary(null, null, null, null, 'product');
  if coalesce(v_summary.gross_total, 0) <> 0 or coalesce(v_summary.sale_count, 0) <> 0 then
    raise exception 'TEST FAILED: shop Y''s product-scoped sales_summary saw shop X''s sales (gross=%, count=%)',
      v_summary.gross_total, v_summary.sale_count using errcode = 'ZZ999';
  end if;

  select count(*) into v_count from top_products(null, null, null, 10, 'service');
  if v_count <> 0 then
    raise exception 'TEST FAILED: shop Y''s service-scoped top_products saw shop X''s haircut (% rows)', v_count using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: shop Y''s type-scoped reports see none of shop X''s product or service activity';
end $$;

reset role;
reset request.jwt.claim.sub;

\echo ''
\echo 'All report type-split (0056) tests passed.'