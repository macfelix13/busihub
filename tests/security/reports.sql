-- Busihub — behaviour/security tests for reports (migration 0032).
--
-- A report is read once and acted on: a bank sees the P&L, a shopkeeper
-- rings whoever is at the top of the receivables list, an insurer is
-- quoted the stock valuation. Nobody re-derives them by hand, so a wrong
-- figure here is a wrong figure acted on.
--
-- Two things get the most attention below:
--
--   * The P&L must AGREE with the dashboard. It is composed from
--     sales_summary() and expense_summary() rather than re-deriving
--     anything, and the assertions check that composition holds rather
--     than just that the arithmetic is internally consistent — a
--     self-consistent statement built on a second definition of "net
--     sales" would pass a weaker test and still be wrong.
--
--   * Payments settle the OLDEST charge first. That is a choice, it is
--     the whole basis of the ageing buckets, and the test for it is the
--     one that would catch a rewrite that quietly changed it: pay off
--     exactly one of two charges and assert that the debt that remains
--     is the NEW one.
--
-- `TEST FAILED` raises carry SQLSTATE ZZ999, which no handler catches.

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000050',
   'authenticated', 'authenticated', 'ownerr@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000051',
   'authenticated', 'authenticated', 'ownerq@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000050';
select register_business('Report Test Shop R', 'Esi', 'Owusu');

-- Two products with deliberately different margins, so a report that
-- confuses cost with price cannot accidentally produce the right answer.
select create_product(
  (select id from businesses where slug = 'report-test-shop-r'),
  'Report Rice', null, null, 'bag', 'zero_rated',
  '{}'::text[],
  '[{"sku": "REP-RICE", "barcode": "", "variant_options": {}, "cost_price": 30, "selling_price": 100, "opening_stock": 50}]'::jsonb,
  (select b.id from branches b
   where b.business_id = (select id from businesses where slug = 'report-test-shop-r') and b.is_main)
);
select create_product(
  (select id from businesses where slug = 'report-test-shop-r'),
  'Report Salt', null, null, 'each', 'zero_rated',
  '{}'::text[],
  '[{"sku": "REP-SALT", "barcode": "", "variant_options": {}, "cost_price": 2, "selling_price": 5, "opening_stock": 100}]'::jsonb,
  (select b.id from branches b
   where b.business_id = (select id from businesses where slug = 'report-test-shop-r') and b.is_main)
);
reset role;
reset request.jwt.claim.sub;

-- A second business that trades nothing, so every isolation assertion
-- has somewhere to fail.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000051';
select register_business('Report Quiet Shop Q', 'Kofi', 'Asante');
reset role;
reset request.jwt.claim.sub;

create table rep_ids as
select
  (select id from businesses where slug = 'report-test-shop-r') as biz_r,
  (select id from businesses where slug = 'report-quiet-shop-q') as biz_q,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'report-test-shop-r') and b.is_main) as branch_r,
  (select id from product_variants where sku = 'REP-RICE') as rice,
  (select id from product_variants where sku = 'REP-SALT') as salt;

grant select on rep_ids to authenticated;

do $$
declare r record;
begin
  select * into r from rep_ids;
  if r.biz_r is null or r.biz_q is null or r.branch_r is null or r.rice is null or r.salt is null then
    raise exception 'TEST FIXTURE BROKEN: rep_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

-- ── trade ────────────────────────────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000050';

do $$
begin
  -- 10 bags of rice at 100.00 on 30.00 of cost: 1000.00 in, 300.00 of
  -- cost, 700.00 of gross profit.
  perform create_sale((select branch_r from rep_ids), '00000000-0000-0000-0000-000000000050',
    null, 'cash', 1000,
    jsonb_build_array(jsonb_build_object('variant_id', (select rice from rep_ids), 'quantity', 10)));

  -- 20 salt at 5.00 on 2.00 of cost: 100.00 in, 40.00 of cost, 60.00 profit.
  perform create_sale((select branch_r from rep_ids), '00000000-0000-0000-0000-000000000050',
    null, 'cash', 100,
    jsonb_build_array(jsonb_build_object('variant_id', (select salt from rep_ids), 'quantity', 20)));

  -- 250.00 of expenses, 100.00 of it out of the till.
  perform create_expense((select branch_r from rep_ids), null, 'Shop rent', 150,
    current_date, 'bank', null, null);
  perform create_expense((select branch_r from rep_ids), null, 'Water', 100,
    current_date, 'cash', null, null);
  -- ...and one that will be voided, so the report has to ignore it.
  perform create_expense((select branch_r from rep_ids), null, 'Recorded twice', 500,
    current_date, 'cash', null, null);
end $$;

do $$
declare v_id uuid;
begin
  select id into v_id from expenses
  where business_id = (select biz_r from rep_ids) and description = 'Recorded twice';
  perform void_expense(v_id, 'Entered by two people');
end $$;

-- ── 1. The chain adds up, and agrees with the dashboard ─────────────────

do $$
declare
  v_pl record; v_sales record; v_exp record; v_from date := current_date; v_to date := current_date;
begin
  select * into v_pl from profit_and_loss(v_from, v_to, (select branch_r from rep_ids), 'Africa/Accra');

  -- 1100.00 in, nothing returned, 340.00 of cost, 250.00 of expenses.
  if v_pl.gross_sales <> 1100.00 or v_pl.refunds <> 0 or v_pl.net_sales <> 1100.00 then
    raise exception 'TEST FAILED: sales read % gross / % back / % net',
      v_pl.gross_sales, v_pl.refunds, v_pl.net_sales using errcode = 'ZZ999';
  end if;
  if v_pl.cost_of_goods <> 340.00 or v_pl.gross_profit <> 760.00 then
    raise exception 'TEST FAILED: cost % gave gross profit %', v_pl.cost_of_goods, v_pl.gross_profit
      using errcode = 'ZZ999';
  end if;

  -- The voided 500.00 must not be in here.
  if v_pl.expense_total <> 250.00 then
    raise exception 'TEST FAILED: expenses read %, expected 250.00 (a voided one counted?)', v_pl.expense_total
      using errcode = 'ZZ999';
  end if;
  if v_pl.net_profit <> 510.00 then
    raise exception 'TEST FAILED: net profit read %, expected 510.00', v_pl.net_profit using errcode = 'ZZ999';
  end if;

  -- Each line follows from the one above it.
  if v_pl.net_sales <> v_pl.gross_sales - v_pl.refunds
     or v_pl.gross_profit <> v_pl.net_sales - v_pl.cost_of_goods
     or v_pl.net_profit <> v_pl.gross_profit - v_pl.expense_total then
    raise exception 'TEST FAILED: the statement does not add up' using errcode = 'ZZ999';
  end if;

  -- And it is the SAME sales and the SAME expenses the rest of Busihub
  -- reports. A P&L built on its own second definition of "net sales"
  -- would pass every assertion above and still disagree with the
  -- dashboard sitting next to it.
  select * into v_sales from sales_summary(
    (v_from::timestamp) at time zone 'Africa/Accra',
    ((v_to + 1)::timestamp) at time zone 'Africa/Accra',
    null, (select branch_r from rep_ids));
  select * into v_exp from expense_summary(v_from, v_to, (select branch_r from rep_ids));

  if v_pl.net_sales <> v_sales.net_total or v_pl.cost_of_goods <> v_sales.cost_total
     or v_pl.gross_profit <> v_sales.gross_profit or v_pl.sale_count <> v_sales.sale_count
     or v_pl.items_sold <> v_sales.items_sold then
    raise exception 'TEST FAILED: the P&L disagrees with sales_summary' using errcode = 'ZZ999';
  end if;
  if v_pl.expense_total <> v_exp.expense_total or v_pl.cash_expenses <> v_exp.cash_paid_out then
    raise exception 'TEST FAILED: the P&L disagrees with expense_summary' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: the P&L adds up and agrees with the dashboard (net profit %)', v_pl.net_profit;
end $$;

-- ── 2. The last day is inside the period ────────────────────────────────

do $$
declare v_today record; v_range record; v_yesterday record;
begin
  select * into v_today from profit_and_loss(current_date, current_date, (select branch_r from rep_ids));
  -- "The 1st to today" must contain today. An exclusive end date here is
  -- the classic off-by-one, and it silently loses the busiest day of any
  -- report someone runs in the afternoon.
  select * into v_range from profit_and_loss(current_date - 7, current_date, (select branch_r from rep_ids));
  if v_range.net_sales <> v_today.net_sales then
    raise exception 'TEST FAILED: a period ending today lost today (% vs %)',
      v_range.net_sales, v_today.net_sales using errcode = 'ZZ999';
  end if;

  -- ...and a period that ends yesterday must NOT contain today.
  select * into v_yesterday from profit_and_loss(current_date - 7, current_date - 1, (select branch_r from rep_ids));
  if v_yesterday.net_sales <> 0 then
    raise exception 'TEST FAILED: a period ending yesterday still counted today (%)', v_yesterday.net_sales
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: the end date is inclusive, and only inclusive of itself';
end $$;

do $$
begin
  begin
    perform profit_and_loss(current_date, current_date - 5, null);
    raise exception 'TEST FAILED: a backwards period was accepted' using errcode = 'ZZ999';
  exception when sqlstate '22023' then
    raise notice 'PASS: a backwards period is refused (%)', sqlerrm;
  end;

  -- An unknown timezone must not take the report down; a report that
  -- errors is worse than one bucketed an hour out.
  if (select net_sales from profit_and_loss(current_date, current_date,
        (select branch_r from rep_ids), 'Middle/Earth')) <> 1100.00 then
    raise exception 'TEST FAILED: an unknown timezone changed the figures' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a bad timezone falls back rather than failing the report';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 3. Receivables: payments settle the oldest charge first ─────────────
--
-- The fixture: one customer owing 100.00 from four months ago and
-- 100.00 from this week, who then pays 100.00. If the payment lands on
-- the OLD charge, what is left is recent. If it lands on the new one —
-- or is simply subtracted from the total — the customer appears to have
-- four-month-old debt they have already settled, and gets chased for it.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000050';

do $$
declare v_customer uuid; v_biz uuid;
begin
  v_biz := (select biz_r from rep_ids);

  insert into customers (business_id, name, phone, credit_limit)
  values (v_biz, 'Ageing Test Customer', '0244000050', 5000)
  returning id into v_customer;

  insert into customer_account_entries (business_id, customer_id, amount, entry_type, note)
  values
    (v_biz, v_customer, 100, 'charge', 'four months ago'),
    (v_biz, v_customer, 100, 'charge', 'this week');

  -- A second customer with one charge in each bucket, to check the
  -- boundaries themselves.
  insert into customers (business_id, name, phone, credit_limit)
  values (v_biz, 'Bucket Test Customer', '0244000051', 5000)
  returning id into v_customer;

  insert into customer_account_entries (business_id, customer_id, amount, entry_type, note)
  values
    (v_biz, v_customer, 10, 'charge', 'five days'),
    (v_biz, v_customer, 20, 'charge', 'forty five days'),
    (v_biz, v_customer, 30, 'charge', 'seventy five days'),
    (v_biz, v_customer, 40, 'charge', 'one hundred and twenty days');

  -- A charge sitting on each bucket boundary. 5/45/75/120 days would
  -- pass an ageing function that got every edge wrong by one, and an
  -- off-by-one here is the difference between "current" and "chase them"
  -- for a real customer.
  insert into customers (business_id, name, phone, credit_limit)
  values (v_biz, 'Boundary Test Customer', '0244000054', 5000)
  returning id into v_customer;

  insert into customer_account_entries (business_id, customer_id, amount, entry_type, note)
  values
    (v_biz, v_customer, 1, 'charge', 'boundary 29'),
    (v_biz, v_customer, 2, 'charge', 'boundary 30'),
    (v_biz, v_customer, 4, 'charge', 'boundary 59'),
    (v_biz, v_customer, 8, 'charge', 'boundary 60'),
    (v_biz, v_customer, 16, 'charge', 'boundary 89'),
    (v_biz, v_customer, 32, 'charge', 'boundary 90');

  -- Someone who paid in full, and someone in credit. Neither is a debt.
  insert into customers (business_id, name, phone, credit_limit)
  values (v_biz, 'Settled Test Customer', '0244000052', 5000)
  returning id into v_customer;
  insert into customer_account_entries (business_id, customer_id, amount, entry_type)
  values (v_biz, v_customer, 60, 'charge'), (v_biz, v_customer, -60, 'payment');

  insert into customers (business_id, name, phone, credit_limit)
  values (v_biz, 'Credit Test Customer', '0244000053', 5000)
  returning id into v_customer;
  insert into customer_account_entries (business_id, customer_id, amount, entry_type)
  values (v_biz, v_customer, 40, 'charge'), (v_biz, v_customer, -100, 'payment');
end $$;

reset role;
reset request.jwt.claim.sub;

-- Backdated as a fixture. The ledger is append-only for everyone using
-- the application (0017 revokes the grants outright), so this is done
-- here as the table owner — there is no application path that could do
-- it, which is the point.
update customer_account_entries set created_at = now() - interval '120 days'
where note = 'four months ago';
update customer_account_entries set created_at = now() - interval '4 days'
where note = 'this week';
update customer_account_entries set created_at = now() - interval '5 days'
where note = 'five days';
update customer_account_entries set created_at = now() - interval '45 days'
where note = 'forty five days';
update customer_account_entries set created_at = now() - interval '75 days'
where note = 'seventy five days';
update customer_account_entries set created_at = now() - interval '120 days'
where note = 'one hundred and twenty days';

-- Midday, so a run near midnight cannot shift a boundary charge into the
-- next bucket and make this file fail for the wrong reason.
update customer_account_entries
set created_at = ((current_date - (substring(note from 'boundary ([0-9]+)'))::int)::timestamp
                  + interval '12 hours') at time zone 'Africa/Accra'
where note like 'boundary %';

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000050';

do $$
declare v_row record; v_customer uuid;
begin
  select id into v_customer from customers
  where business_id = (select biz_r from rep_ids) and name = 'Ageing Test Customer';

  -- Before any payment: 100.00 old, 100.00 recent.
  select * into v_row from receivables_aging() where receivables_aging.customer_id = v_customer;
  if v_row.total_owed <> 200.00 or v_row.days_90_plus <> 100.00 or v_row.current_amount <> 100.00 then
    raise exception 'TEST FAILED: expected 100 old + 100 current, got % / % / %',
      v_row.total_owed, v_row.days_90_plus, v_row.current_amount using errcode = 'ZZ999';
  end if;

  insert into customer_account_entries (business_id, customer_id, amount, entry_type)
  values ((select biz_r from rep_ids), v_customer, -100, 'payment');

  select * into v_row from receivables_aging() where receivables_aging.customer_id = v_customer;

  if v_row.total_owed <> 100.00 then
    raise exception 'TEST FAILED: after paying 100 of 200 they owe %', v_row.total_owed using errcode = 'ZZ999';
  end if;
  -- THE assertion in this file. The payment settled the four-month-old
  -- charge, so what is left is this week's.
  if v_row.days_90_plus <> 0 then
    raise exception 'TEST FAILED: the payment did not clear the oldest charge (% still 90+ days)',
      v_row.days_90_plus using errcode = 'ZZ999';
  end if;
  if v_row.current_amount <> 100.00 then
    raise exception 'TEST FAILED: the remaining debt should be current, got %', v_row.current_amount
      using errcode = 'ZZ999';
  end if;
  -- ...and the "oldest unpaid" they get chased about moves with it.
  if v_row.oldest_unpaid < (current_date - 10) then
    raise exception 'TEST FAILED: oldest unpaid still reads %, but that charge is paid', v_row.oldest_unpaid
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a payment settles the oldest charge, and the ageing moves with it';
end $$;

do $$
declare v_row record; v_customer uuid; v_n int;
begin
  select id into v_customer from customers
  where business_id = (select biz_r from rep_ids) and name = 'Bucket Test Customer';
  select * into v_row from receivables_aging() where receivables_aging.customer_id = v_customer;

  if v_row.current_amount <> 10.00 or v_row.days_30 <> 20.00
     or v_row.days_60 <> 30.00 or v_row.days_90_plus <> 40.00 then
    raise exception 'TEST FAILED: buckets read % / % / % / %',
      v_row.current_amount, v_row.days_30, v_row.days_60, v_row.days_90_plus using errcode = 'ZZ999';
  end if;
  -- The parts must be the whole: a debt that falls between two buckets
  -- would vanish from the report while still being owed.
  if v_row.total_owed <> v_row.current_amount + v_row.days_30 + v_row.days_60 + v_row.days_90_plus then
    raise exception 'TEST FAILED: the buckets do not sum to the total' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: each age bucket is right and the parts sum to the whole';

  -- The boundaries themselves. 29 days is current; 30 is not. 59 is in
  -- the 30-day bucket; 60 is not. Powers of two so a misplaced charge
  -- names itself in the failure message.
  select id into v_customer from customers
  where business_id = (select biz_r from rep_ids) and name = 'Boundary Test Customer';
  select * into v_row from receivables_aging() where receivables_aging.customer_id = v_customer;

  if v_row.current_amount <> 1 then
    raise exception 'TEST FAILED: current should hold only the 29-day charge, got %', v_row.current_amount
      using errcode = 'ZZ999';
  end if;
  if v_row.days_30 <> 6 then
    raise exception 'TEST FAILED: the 30-day bucket should hold 30 and 59 days (2+4), got %', v_row.days_30
      using errcode = 'ZZ999';
  end if;
  if v_row.days_60 <> 24 then
    raise exception 'TEST FAILED: the 60-day bucket should hold 60 and 89 days (8+16), got %', v_row.days_60
      using errcode = 'ZZ999';
  end if;
  if v_row.days_90_plus <> 32 then
    raise exception 'TEST FAILED: the 90+ bucket should hold the 90-day charge (32), got %', v_row.days_90_plus
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: every bucket boundary falls on the right side';

  -- A settled account and one in credit are not debts.
  select count(*) into v_n from receivables_aging() r
  join customers c on c.id = r.customer_id
  where c.name in ('Settled Test Customer', 'Credit Test Customer');
  if v_n <> 0 then
    raise exception 'TEST FAILED: % settled or in-credit customers appeared as debtors', v_n
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: settled and in-credit customers are absent from the debtor list';
end $$;

do $$
declare v_aged numeric; v_balance numeric; v_customer uuid;
begin
  -- The report and the running balance must not disagree. They are
  -- computed completely differently — one walks the ledger, the other is
  -- a trigger-maintained total — so this is a real cross-check.
  for v_customer in
    select r.customer_id from receivables_aging() r
  loop
    select total_owed into v_aged from receivables_aging() where receivables_aging.customer_id = v_customer;
    select balance into v_balance from customer_balances where customer_balances.customer_id = v_customer;
    if v_aged <> v_balance then
      raise exception 'TEST FAILED: ageing says % but the balance says % for %', v_aged, v_balance, v_customer
        using errcode = 'ZZ999';
    end if;
  end loop;
  raise notice 'PASS: the ageing total matches the running balance for every debtor';
end $$;

-- ── 4. Stock valuation ──────────────────────────────────────────────────

do $$
declare
  v_rice record; v_totals record; v_page_sum numeric; v_lines int;
begin
  select * into v_rice from stock_valuation((select branch_r from rep_ids), 100) where sku = 'REP-RICE';

  -- 50 received, 10 sold. 40 at 30.00 cost and 100.00 retail.
  if v_rice.quantity <> 40 then
    raise exception 'TEST FAILED: expected 40 bags left, got %', v_rice.quantity using errcode = 'ZZ999';
  end if;
  if v_rice.cost_value <> 1200.00 or v_rice.retail_value <> 4000.00 then
    raise exception 'TEST FAILED: 40 bags valued at % cost / % retail', v_rice.cost_value, v_rice.retail_value
      using errcode = 'ZZ999';
  end if;

  select * into v_totals from stock_valuation_totals((select branch_r from rep_ids));
  -- 40 rice at 30 = 1200, 80 salt at 2 = 160.
  if v_totals.cost_value <> 1360.00 or v_totals.retail_value <> 4400.00 then
    raise exception 'TEST FAILED: stockroom valued at % cost / % retail',
      v_totals.cost_value, v_totals.retail_value using errcode = 'ZZ999';
  end if;
  if v_totals.negative_lines <> 0 then
    raise exception 'TEST FAILED: % lines report negative stock unexpectedly', v_totals.negative_lines
      using errcode = 'ZZ999';
  end if;

  -- The totals must cover every line, not the page being shown. This is
  -- the whole reason they are a separate function: a shop with 3,000
  -- lines shown 200 at a time would otherwise be told its stockroom is
  -- worth a fifteenth of what is in it.
  select count(*), coalesce(sum(cost_value), 0) into v_lines, v_page_sum
  from stock_valuation((select branch_r from rep_ids), 1);
  if v_lines <> 1 then
    raise exception 'TEST FAILED: the limit was ignored (% rows)', v_lines using errcode = 'ZZ999';
  end if;
  if v_page_sum = v_totals.cost_value then
    raise exception 'TEST FAILED: the fixture cannot tell a page total from the real one'
      using errcode = 'ZZ999';
  end if;
  select cost_value into v_page_sum from stock_valuation_totals((select branch_r from rep_ids));
  if v_page_sum <> 1360.00 then
    raise exception 'TEST FAILED: the totals followed the page limit (%)', v_page_sum using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: stock is valued at cost and retail, and the totals cover every line';
end $$;

do $$
declare v_before numeric; v_after numeric; v_n int;
begin
  select cost_value into v_before from stock_valuation_totals((select branch_r from rep_ids));

  -- An archived product is not stock you can sell, so it is not stock
  -- you can count as an asset.
  update products set status = 'archived'
  where business_id = (select biz_r from rep_ids) and name = 'Report Salt';

  select cost_value into v_after from stock_valuation_totals((select branch_r from rep_ids));
  if v_after <> v_before - 160.00 then
    raise exception 'TEST FAILED: archiving a product left it in the valuation (% -> %)', v_before, v_after
      using errcode = 'ZZ999';
  end if;
  select count(*) into v_n from stock_valuation((select branch_r from rep_ids), 100) where sku = 'REP-SALT';
  if v_n <> 0 then
    raise exception 'TEST FAILED: an archived product is still listed' using errcode = 'ZZ999';
  end if;

  update products set status = 'active'
  where business_id = (select biz_r from rep_ids) and name = 'Report Salt';

  raise notice 'PASS: archived products are not counted as stock on hand';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 5. None of it belongs to anyone else ────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000051';

do $$
declare v_pl record; v_n int; v_totals record;
begin
  select * into v_pl from profit_and_loss(current_date - 200, current_date);
  if v_pl.net_sales <> 0 or v_pl.gross_profit <> 0 or v_pl.expense_total <> 0 or v_pl.net_profit <> 0 then
    raise exception 'TEST FAILED: another business''s P&L is visible (% net, % profit)',
      v_pl.net_sales, v_pl.net_profit using errcode = 'ZZ999';
  end if;

  select count(*) into v_n from receivables_aging();
  if v_n <> 0 then
    raise exception 'TEST FAILED: % of another business''s debtors are visible', v_n using errcode = 'ZZ999';
  end if;

  select count(*) into v_n from stock_valuation(null, 500);
  if v_n <> 0 then
    raise exception 'TEST FAILED: another business''s stock is visible (% lines)', v_n using errcode = 'ZZ999';
  end if;

  select * into v_totals from stock_valuation_totals();
  if v_totals.cost_value <> 0 then
    raise exception 'TEST FAILED: another business''s stockroom is worth % to this one', v_totals.cost_value
      using errcode = 'ZZ999';
  end if;

  -- Naming their branch narrows what RLS already allowed; it cannot
  -- widen it.
  select * into v_pl from profit_and_loss(current_date - 200, current_date, (select branch_r from rep_ids));
  if v_pl.net_sales <> 0 then
    raise exception 'TEST FAILED: naming another business''s branch returned % of their sales', v_pl.net_sales
      using errcode = 'ZZ999';
  end if;
  select * into v_totals from stock_valuation_totals((select branch_r from rep_ids));
  if v_totals.cost_value <> 0 then
    raise exception 'TEST FAILED: naming another business''s branch valued their stock at %',
      v_totals.cost_value using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a second business sees none of the first business''s reports';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 6. The one-word regression ──────────────────────────────────────────

do $$
declare v_bad text;
begin
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and p.proname in (
      'profit_and_loss', 'receivables_aging', 'stock_valuation', 'stock_valuation_totals'
    );
  if v_bad is not null then
    raise exception 'TEST FAILED: report function(s) are SECURITY DEFINER and bypass RLS: %', v_bad
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: every report function runs as the caller, so RLS scopes it';
end $$;