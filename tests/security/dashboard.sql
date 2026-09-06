-- Busihub — behaviour/security tests for the dashboard analytics (0030).
--
-- These six functions are the ones a business would least like a
-- neighbour to read: takings, margins, who sells what, which branch is
-- behind. So this file asserts two different things about each of them:
--
--   1. The number is RIGHT — gap-filled, net of returns, net of change
--      given, and excluding money that has not actually arrived.
--   2. The number is THEIRS — a second business, querying the same
--      function in the same database, sees none of it.
--
-- It also asserts, from the catalog, that none of them is SECURITY
-- DEFINER. That is the single change that would silently turn all of (2)
-- into a leak, and it is one word in a migration, so it is checked
-- directly rather than only through its symptoms.
--
-- Everything is measured against a business created by this file, and
-- the few figures taken from a shared business are deltas — no assertion
-- here depends on which suites ran before it.
--
-- `TEST FAILED` raises carry SQLSTATE ZZ999, which no handler catches.

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000047',
   'authenticated', 'authenticated', 'ownerd@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000047';
select register_business('Dashboard Test Shop D', 'Kwabena', 'Mensah');

-- Widget and Gadget have deliberately different margins: 20 on a 30 sale
-- against 10 on a 50 one. A dashboard that ranks by revenue and one that
-- ranks by profit disagree about these two, which is the whole reason
-- top_products reports both.
select create_product(
  (select id from businesses where slug = 'dashboard-test-shop-d'),
  'Dash Widget', null, null, 'each', 'zero_rated',
  '{}'::text[],
  '[{"sku": "DASH-W", "barcode": "", "variant_options": {}, "cost_price": 10, "selling_price": 30, "opening_stock": 100}]'::jsonb,
  (select b.id from branches b
   where b.business_id = (select id from businesses where slug = 'dashboard-test-shop-d') and b.is_main)
);
select create_product(
  (select id from businesses where slug = 'dashboard-test-shop-d'),
  'Dash Gadget', null, null, 'each', 'zero_rated',
  '{}'::text[],
  '[{"sku": "DASH-G", "barcode": "", "variant_options": {}, "cost_price": 40, "selling_price": 50, "opening_stock": 100}]'::jsonb,
  (select b.id from branches b
   where b.business_id = (select id from businesses where slug = 'dashboard-test-shop-d') and b.is_main)
);
select create_product(
  (select id from businesses where slug = 'dashboard-test-shop-d'),
  'Dash Sachet', null, null, 'each', 'zero_rated',
  '{}'::text[],
  '[{"sku": "DASH-S", "barcode": "", "variant_options": {}, "cost_price": 1, "selling_price": 2, "opening_stock": 5}]'::jsonb,
  (select b.id from branches b
   where b.business_id = (select id from businesses where slug = 'dashboard-test-shop-d') and b.is_main)
);

-- A second branch that never sells anything. The most useful row on a
-- branch comparison is the branch with nothing on it, so there has to be
-- one to test with.
insert into branches (business_id, name, is_main)
values ((select id from businesses where slug = 'dashboard-test-shop-d'), 'Dash Quiet Branch', false);

reset role;
reset request.jwt.claim.sub;

create table d_ids as
select
  (select id from businesses where slug = 'dashboard-test-shop-d') as biz_d,
  (select id from businesses where slug = 'sales-test-shop-f')     as biz_f,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'dashboard-test-shop-d') and b.is_main) as branch_d,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'dashboard-test-shop-d')
     and b.name = 'Dash Quiet Branch')                             as branch_quiet,
  (select id from product_variants where sku = 'DASH-W')           as widget,
  (select id from product_variants where sku = 'DASH-G')           as gadget,
  (select id from product_variants where sku = 'DASH-S')           as sachet;

-- Sales this file makes, so later sections can refer to them by name
-- rather than by "the most recent one", which stops being true the
-- moment another suite rings something up.
create table d_ids_sales (id uuid, tag text);

-- ── 1. The trend gap-fills, and buckets in local time ───────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000047';

do $$
declare v_sale uuid;
begin
  -- Two widgets: 60.00 taken, 20.00 of cost, 40.00 of profit.
  select create_sale((select branch_d from d_ids), '00000000-0000-0000-0000-000000000047',
    null, 'cash', 60,
    jsonb_build_array(jsonb_build_object('variant_id', (select widget from d_ids), 'quantity', 2))
  ) into v_sale;
  insert into d_ids_sales values (v_sale, 'old');
end $$;

reset role;
reset request.jwt.claim.sub;

-- Backdated as a fixture, not through the application: create_sale stamps
-- now(), and this suite needs a quiet stretch between two days of trade.
update sales set created_at = now() - interval '3 days'
where id = (select id from d_ids_sales where tag = 'old');

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000047';

do $$
declare v_sale uuid;
begin
  -- One gadget today: 50.00 taken, 40.00 of cost, 10.00 of profit.
  select create_sale((select branch_d from d_ids), '00000000-0000-0000-0000-000000000047',
    null, 'cash', 50,
    jsonb_build_array(jsonb_build_object('variant_id', (select gadget from d_ids), 'quantity', 1))
  ) into v_sale;
  insert into d_ids_sales values (v_sale, 'today');
end $$;

do $$
declare
  v_rows int; v_old record; v_today record; v_empty int;
begin
  select count(*) into v_rows
  from sales_trend(now() - interval '4 days', now(), (select branch_d from d_ids), 'day');
  -- Five day-boundaries between four days ago and today, inclusive.
  if v_rows <> 5 then
    raise exception 'TEST FAILED: expected 5 daily buckets, got %', v_rows using errcode = 'ZZ999';
  end if;

  select * into v_old
  from sales_trend(now() - interval '4 days', now(), (select branch_d from d_ids), 'day') t
  where t.bucket_start::date = (now() - interval '3 days')::date;
  if v_old.sale_count <> 1 or v_old.net_total <> 60.00 or v_old.gross_profit <> 40.00 then
    raise exception 'TEST FAILED: the older day read % sales / % net / % profit',
      v_old.sale_count, v_old.net_total, v_old.gross_profit using errcode = 'ZZ999';
  end if;

  select * into v_today
  from sales_trend(now() - interval '4 days', now(), (select branch_d from d_ids), 'day') t
  where t.bucket_start::date = now()::date;
  if v_today.sale_count <> 1 or v_today.net_total <> 50.00 or v_today.gross_profit <> 10.00 then
    raise exception 'TEST FAILED: today read % sales / % net / % profit',
      v_today.sale_count, v_today.net_total, v_today.gross_profit using errcode = 'ZZ999';
  end if;

  -- The days in between must be present as zeroes. A chart that drops
  -- empty days draws a straight line through a dead week.
  select count(*) into v_empty
  from sales_trend(now() - interval '4 days', now(), (select branch_d from d_ids), 'day') t
  where t.sale_count = 0 and t.net_total = 0;
  if v_empty <> 3 then
    raise exception 'TEST FAILED: expected 3 quiet days shown as zero, got %', v_empty
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: the sales trend gap-fills quiet days and buckets profit correctly';
end $$;

-- ── 2. A return is subtracted from the day it was given ─────────────────

do $$
declare
  v_item uuid; v_old record; v_today record;
begin
  select si.id into v_item from sale_items si
  where si.sale_id = (select id from d_ids_sales where tag = 'old') limit 1;

  -- One of the two widgets comes back today, against a sale from three
  -- days ago: 30.00 of revenue and 10.00 of cost reversed.
  perform create_refund((select id from d_ids_sales where tag = 'old'),
    '00000000-0000-0000-0000-000000000047', 'cash', 'Changed their mind',
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 1, 'restock', true)));

  select * into v_old
  from sales_trend(now() - interval '4 days', now(), (select branch_d from d_ids), 'day') t
  where t.bucket_start::date = (now() - interval '3 days')::date;
  if v_old.net_total <> 60.00 then
    raise exception 'TEST FAILED: the refund rewrote the day the sale happened (now %)', v_old.net_total
      using errcode = 'ZZ999';
  end if;

  select * into v_today
  from sales_trend(now() - interval '4 days', now(), (select branch_d from d_ids), 'day') t
  where t.bucket_start::date = now()::date;
  -- 50.00 in, 30.00 back out.
  if v_today.net_total <> 20.00 then
    raise exception 'TEST FAILED: today should net 20.00 after the return, got %', v_today.net_total
      using errcode = 'ZZ999';
  end if;
  -- 40.00 of cost went out, 10.00 of it came back: 20.00 net against
  -- 30.00 of cost is a loss, and the chart must be willing to say so.
  if v_today.gross_profit <> -10.00 then
    raise exception 'TEST FAILED: today should show -10.00 profit, got %', v_today.gross_profit
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a return lands on the day it was given and can take a day negative';
end $$;

-- ── 3. Cash is counted net of the change handed back ────────────────────

do $$
declare
  v_before numeric; v_after numeric; v_sale uuid;
begin
  select coalesce(sum(amount), 0) into v_before
  from payment_method_breakdown(null, null, (select branch_d from d_ids)) where method = 'cash';

  -- Two gadgets, 100.00 due, 200.00 handed over, 100.00 change back.
  select create_sale((select branch_d from d_ids), '00000000-0000-0000-0000-000000000047',
    null, 'cash', 200,
    jsonb_build_array(jsonb_build_object('variant_id', (select gadget from d_ids), 'quantity', 2))
  ) into v_sale;
  insert into d_ids_sales values (v_sale, 'change');

  select coalesce(sum(amount), 0) into v_after
  from payment_method_breakdown(null, null, (select branch_d from d_ids)) where method = 'cash';

  if v_after - v_before <> 100.00 then
    raise exception 'TEST FAILED: a 100.00 sale with 100.00 change added % to cash taken', v_after - v_before
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: cash taken is the tender less the change, not what was handed over';
end $$;

-- ── 4. Money that has not arrived is not counted ────────────────────────

do $$
declare v_before numeric; v_after numeric; v_sale uuid;
begin
  select coalesce(sum(amount), 0) into v_before
  from payment_method_breakdown(null, null, (select branch_d from d_ids));
  v_sale := (select id from d_ids_sales where tag = 'change');

  -- A prompt sitting on someone's phone, and one they declined. Neither
  -- is money. This is the requirement stated plainly: an online payment
  -- counts only once the backend has verified it.
  insert into sale_payments (business_id, sale_id, branch_id, method, amount, status, provider)
  values
    ((select biz_d from d_ids), v_sale, (select branch_d from d_ids), 'momo', 500, 'pending', 'paystack'),
    ((select biz_d from d_ids), v_sale, (select branch_d from d_ids), 'momo', 700, 'failed', 'paystack');

  select coalesce(sum(amount), 0) into v_after
  from payment_method_breakdown(null, null, (select branch_d from d_ids));

  if v_after <> v_before then
    raise exception 'TEST FAILED: an unsettled momo prompt was counted as takings (% -> %)',
      v_before, v_after using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: pending and failed tenders are not counted as money taken';
end $$;

-- ── 5. Top products: net of returns, and ranked by profit ───────────────

do $$
declare v_first record; v_second record; v_rows int;
begin
  select count(*) into v_rows from top_products(null, null, (select branch_d from d_ids), 10);
  if v_rows <> 2 then
    raise exception 'TEST FAILED: expected 2 products sold, got %', v_rows using errcode = 'ZZ999';
  end if;

  select * into v_first from top_products(null, null, (select branch_d from d_ids), 10) limit 1;
  select * into v_second from top_products(null, null, (select branch_d from d_ids), 10) offset 1 limit 1;

  -- Gadget: 3 sold at 50.00 on 40.00 of cost = 150.00 revenue, 30.00 profit.
  if v_first.sku <> 'DASH-G' or v_first.quantity_sold <> 3 or v_first.revenue <> 150.00
     or v_first.gross_profit <> 30.00 then
    raise exception 'TEST FAILED: top product read % / % / % / %',
      v_first.sku, v_first.quantity_sold, v_first.revenue, v_first.gross_profit using errcode = 'ZZ999';
  end if;

  -- Widget: 2 sold, 1 returned. The returned one must not still be on
  -- the leaderboard.
  if v_second.sku <> 'DASH-W' or v_second.quantity_sold <> 1 or v_second.revenue <> 30.00
     or v_second.gross_profit <> 20.00 then
    raise exception 'TEST FAILED: second product read % / % / % / %',
      v_second.sku, v_second.quantity_sold, v_second.revenue, v_second.gross_profit using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: best sellers are net of returns and ranked by what they actually earned';
end $$;

-- ── 6. Low stock: three states, and a per-product threshold ─────────────

do $$
declare
  v_w record; v_g record; v_s record; v_first record; v_qty numeric;
begin
  -- Widget: threshold 10, stock brought down to 8. Under the business's
  -- own fallback of 5 this would NOT be low — so if this row is missing,
  -- the per-variant reorder point is being ignored.
  update product_variants set reorder_point = 10 where id = (select widget from d_ids);
  update product_variants set reorder_point = 4 where id = (select gadget from d_ids);

  select quantity into v_qty from stock_levels
  where branch_id = (select branch_d from d_ids) and variant_id = (select widget from d_ids);
  insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
  values ((select branch_d from d_ids), (select widget from d_ids), 8 - v_qty, 'adjustment');

  select quantity into v_qty from stock_levels
  where branch_id = (select branch_d from d_ids) and variant_id = (select gadget from d_ids);
  insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
  values ((select branch_d from d_ids), (select gadget from d_ids), 1 - v_qty, 'adjustment');

  -- Sold down to nothing: no reorder point of its own, so it falls back
  -- to the business's threshold, and zero is zero under any threshold.
  select quantity into v_qty from stock_levels
  where branch_id = (select branch_d from d_ids) and variant_id = (select sachet from d_ids);
  insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
  values ((select branch_d from d_ids), (select sachet from d_ids), 0 - v_qty, 'adjustment');

  select * into v_w from low_stock_report((select branch_d from d_ids), 50)
  where sku = 'DASH-W';
  select * into v_g from low_stock_report((select branch_d from d_ids), 50)
  where sku = 'DASH-G';
  select * into v_s from low_stock_report((select branch_d from d_ids), 50)
  where sku = 'DASH-S';

  if v_w.severity is distinct from 'low' then
    raise exception 'TEST FAILED: 8 against a reorder point of 10 read %', coalesce(v_w.severity, '(missing)')
      using errcode = 'ZZ999';
  end if;
  if v_w.reorder_point <> 10 then
    raise exception 'TEST FAILED: the per-product reorder point was ignored (read %)', v_w.reorder_point
      using errcode = 'ZZ999';
  end if;
  if v_g.severity is distinct from 'critical' then
    raise exception 'TEST FAILED: 1 against a reorder point of 4 read %', coalesce(v_g.severity, '(missing)')
      using errcode = 'ZZ999';
  end if;
  if v_s.severity is distinct from 'out' then
    raise exception 'TEST FAILED: nothing on the shelf read %', coalesce(v_s.severity, '(missing)')
      using errcode = 'ZZ999';
  end if;

  -- Whatever is already gone is what needs answering first.
  select * into v_first from low_stock_report((select branch_d from d_ids), 50) limit 1;
  if v_first.severity <> 'out' then
    raise exception 'TEST FAILED: the worst case was not listed first (% was)', v_first.severity
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: low stock separates out/critical/low and honours a per-product reorder point';
end $$;

-- ── 7. Staff: returns shown beside takings, not folded into them ────────

do $$
declare v_row record; v_rows int;
begin
  select count(*) into v_rows from staff_performance(null, null, (select branch_d from d_ids), 50);
  if v_rows <> 1 then
    raise exception 'TEST FAILED: expected one cashier at this branch, got %', v_rows using errcode = 'ZZ999';
  end if;

  select * into v_row from staff_performance(null, null, (select branch_d from d_ids), 50) limit 1;
  -- 60.00 + 50.00 + 100.00 rung up, 30.00 of it given back.
  if v_row.sale_count <> 3 or v_row.gross_total <> 210.00 or v_row.refunded_total <> 30.00
     or v_row.net_total <> 180.00 then
    raise exception 'TEST FAILED: staff row read % sales / % gross / % back / % net',
      v_row.sale_count, v_row.gross_total, v_row.refunded_total, v_row.net_total using errcode = 'ZZ999';
  end if;
  if v_row.cashier_id <> '00000000-0000-0000-0000-000000000047' then
    raise exception 'TEST FAILED: the sale was attributed to the wrong person' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: takings and returns are reported side by side per cashier';
end $$;

-- ── 8. Branches: the one that sold nothing still appears ────────────────

do $$
declare v_main record; v_quiet record;
begin
  select * into v_main from branch_performance() where branch_id = (select branch_d from d_ids);
  select * into v_quiet from branch_performance() where branch_id = (select branch_quiet from d_ids);

  if v_main.sale_count <> 3 or v_main.net_total <> 180.00 then
    raise exception 'TEST FAILED: the main branch read % sales / % net', v_main.sale_count, v_main.net_total
      using errcode = 'ZZ999';
  end if;
  -- 140.00 of cost went out, 10.00 came back with the returned widget.
  if v_main.gross_profit <> 50.00 then
    raise exception 'TEST FAILED: branch profit read %, expected 50.00', v_main.gross_profit
      using errcode = 'ZZ999';
  end if;
  if v_quiet is null or v_quiet.sale_count <> 0 or v_quiet.net_total <> 0 then
    raise exception 'TEST FAILED: a branch that sold nothing was left off the comparison'
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: every active branch is listed, including one that took nothing';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 9. None of it belongs to anyone else ────────────────────────────────
--
-- Same functions, same database, a different business's owner. Not one
-- figure above may appear.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000046';

do $$
declare v_n int; v_sum numeric;
begin
  -- The trend: business F has taken nothing, and must be told so rather
  -- than shown D's week.
  select coalesce(sum(net_total), 0) into v_sum
  from sales_trend(now() - interval '4 days', now(), null, 'day');
  if v_sum <> 0 then
    raise exception 'TEST FAILED: another business''s takings appeared in the trend (%)', v_sum
      using errcode = 'ZZ999';
  end if;

  select count(*) into v_n from payment_method_breakdown();
  if v_n <> 0 then
    raise exception 'TEST FAILED: another business''s tenders were visible (% rows)', v_n
      using errcode = 'ZZ999';
  end if;

  select count(*) into v_n from top_products(null, null, null, 50);
  if v_n <> 0 then
    raise exception 'TEST FAILED: another business''s best sellers were visible (% rows)', v_n
      using errcode = 'ZZ999';
  end if;

  select count(*) into v_n from staff_performance(null, null, null, 100);
  if v_n <> 0 then
    raise exception 'TEST FAILED: another business''s staff figures were visible (% rows)', v_n
      using errcode = 'ZZ999';
  end if;

  select count(*) into v_n from low_stock_report(null, 200)
  where sku like 'DASH-%';
  if v_n <> 0 then
    raise exception 'TEST FAILED: another business''s stock levels were visible (% rows)', v_n
      using errcode = 'ZZ999';
  end if;

  select count(*) into v_n from branch_performance()
  where branch_name like 'Dash%';
  if v_n <> 0 then
    raise exception 'TEST FAILED: another business''s branches were visible (% rows)', v_n
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a second business sees none of the first business''s dashboard';
end $$;

-- Passing a branch id that belongs to someone else is not a way in
-- either: the filter narrows what RLS already allowed, it cannot widen
-- it. This is the "IDs supplied by the browser" case, tested directly.
do $$
declare v_n int; v_sum numeric;
begin
  select count(*), coalesce(sum(net_total), 0) into v_n, v_sum
  from sales_trend(now() - interval '4 days', now(), (select branch_d from d_ids), 'day');
  if v_sum <> 0 then
    raise exception 'TEST FAILED: naming another business''s branch returned its takings (%)', v_sum
      using errcode = 'ZZ999';
  end if;

  select count(*) into v_n from top_products(null, null, (select branch_d from d_ids), 50);
  if v_n <> 0 then
    raise exception 'TEST FAILED: naming another business''s branch returned its products' using errcode = 'ZZ999';
  end if;

  select count(*) into v_n from low_stock_report((select branch_d from d_ids), 200);
  if v_n <> 0 then
    raise exception 'TEST FAILED: naming another business''s branch returned its stock' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: supplying another business''s branch id returns nothing, not their data';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 10. The one-word regression ─────────────────────────────────────────
--
-- Everything above rests on these running as the caller. SECURITY
-- DEFINER is one word, and adding it would leave every assertion in
-- section 9 as the only thing standing between a shop and its
-- neighbour's takings. Assert the property itself, from the catalog.

do $$
declare v_bad text;
begin
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and p.proname in (
      'sales_trend', 'payment_method_breakdown', 'top_products',
      'low_stock_report', 'staff_performance', 'branch_performance',
      'sales_summary', 'dashboard_snapshot'
    );
  if v_bad is not null then
    raise exception 'TEST FAILED: reporting function(s) are SECURITY DEFINER and bypass RLS: %', v_bad
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: every reporting function runs as the caller, so RLS scopes it';
end $$;