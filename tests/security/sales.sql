-- Busihub — behaviour/security test for sales (migration 0020).
--
-- The till is where the three ledgers meet, so most of these assert that a
-- REJECTED sale leaves nothing behind: no sale row, no stock movement, no
-- customer balance. A partial sale is worse than a refused one.
--
-- `TEST FAILED` raises carry SQLSTATE ZZ999, which no handler here catches
-- (the default, P0001, is caught below as an expected rejection).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000046',
   'authenticated', 'authenticated', 'ownerf@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000096',
   'authenticated', 'authenticated', 'auditor2@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000046';
select register_business('Sales Test Shop F', 'Adjoa', 'Nkrumah');
reset role;
reset request.jwt.claim.sub;

-- Business A: a standard-rated product and a zero-rated one.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select create_product(
  (select id from businesses where slug = 'busihub-demo-store'),
  'Sale Test Soap', null, null, 'each', 'standard',
  '{}'::text[],
  '[{"sku": "SOAP-1", "barcode": "5901234123457", "variant_options": {}, "cost_price": 6, "selling_price": 100}]'::jsonb
);
select create_product(
  (select id from businesses where slug = 'busihub-demo-store'),
  'Sale Test Bread', null, null, 'each', 'zero_rated',
  '{}'::text[],
  '[{"sku": "BREAD-1", "barcode": "", "variant_options": {}, "cost_price": 3, "selling_price": 50}]'::jsonb
);
reset role;
reset request.jwt.claim.sub;

create table s_ids as
select
  (select id from businesses where slug = 'busihub-demo-store')     as biz_a,
  (select id from businesses where slug = 'sales-test-shop-f')      as biz_f,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'busihub-demo-store') and b.is_main)  as branch_a,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'sales-test-shop-f') and b.is_main)   as branch_f,
  (select id from product_variants where sku = 'SOAP-1')            as soap,
  (select id from product_variants where sku = 'BREAD-1')           as bread;

do $$
declare r record;
begin
  select * into r from s_ids;
  if r.biz_a is null or r.biz_f is null or r.branch_a is null or r.branch_f is null
     or r.soap is null or r.bread is null then
    raise exception 'TEST FIXTURE BROKEN: s_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

grant select on s_ids to authenticated;

-- An Auditor (no sales.process) for the permission test.
do $$
declare v_biz uuid; v_branch uuid; v_role uuid;
begin
  select biz_a, branch_a into v_biz, v_branch from s_ids;
  select id into v_role from roles where business_id = v_biz and name = 'Auditor';
  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000096', v_biz, 'Read', 'Only2', 'auditor2@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);
  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000000096', v_role,
            '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;
end $$;

-- Stock to sell: 20 soap, 10 bread.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
select branch_a, soap, 20, 'receive' from s_ids;
insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
select branch_a, bread, 10, 'receive' from s_ids;

-- ── 1. A cash sale: totals, stock, receipt number ────────────────────────

do $$
declare
  v_sale uuid; v_s record; v_stock numeric; v_items int; v_price numeric;
begin
  select create_sale(
    (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null,
    'cash', 200,
    jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
  ) into v_sale;

  select * into v_s from sales where id = v_sale;

  if v_s.receipt_number <> 'R-000001' then
    raise exception 'TEST FAILED: expected receipt R-000001, got %', v_s.receipt_number using errcode = 'ZZ999';
  end if;

  -- Default settings: VAT 15%, levies 6%, tax-INCLUSIVE. A 100.00 shelf
  -- price therefore contains the tax rather than adding to it.
  if v_s.total <> 100.00 then
    raise exception 'TEST FAILED: an inclusive-priced item at 100.00 should total 100.00, got %', v_s.total
      using errcode = 'ZZ999';
  end if;
  -- The invariant that matters: the parts must sum to the whole exactly,
  -- with no stray pesewa from rounding each separately.
  if v_s.subtotal + v_s.tax_total <> v_s.total then
    raise exception 'TEST FAILED: % + % <> %', v_s.subtotal, v_s.tax_total, v_s.total using errcode = 'ZZ999';
  end if;
  if v_s.tax_total <= 0 then
    raise exception 'TEST FAILED: a standard-rated item recorded no tax' using errcode = 'ZZ999';
  end if;
  if v_s.change_given <> 100.00 then
    raise exception 'TEST FAILED: expected 100.00 change from 200 on a 100 sale, got %', v_s.change_given
      using errcode = 'ZZ999';
  end if;

  -- The price was taken from the catalog, not from the caller (there is
  -- no price parameter to pass at all).
  select unit_price into v_price from sale_items where sale_id = v_sale;
  if v_price <> 100.00 then
    raise exception 'TEST FAILED: unit_price should come from the catalog, got %', v_price using errcode = 'ZZ999';
  end if;

  select quantity into v_stock from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);
  if v_stock <> 19 then
    raise exception 'TEST FAILED: expected 19 in stock after selling 1 of 20, got %', v_stock using errcode = 'ZZ999';
  end if;

  if not exists (
    select 1 from inventory_movements
    where reference_type = 'sale' and reference_id = v_sale and reason = 'sale' and quantity_delta = -1
  ) then
    raise exception 'TEST FAILED: no stock movement linked back to the sale' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: cash sale — total %, tax %, change %, stock 20 -> 19, movement linked',
    v_s.total, v_s.tax_total, v_s.change_given;
end $$;

-- ── 2. A zero-rated item carries no tax ──────────────────────────────────

do $$
declare v_sale uuid; v_s record;
begin
  select create_sale(
    (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 50,
    jsonb_build_array(jsonb_build_object('variant_id', (select bread from s_ids), 'quantity', 1))
  ) into v_sale;

  select * into v_s from sales where id = v_sale;
  if v_s.tax_total <> 0 then
    raise exception 'TEST FAILED: a zero-rated item was taxed (%)', v_s.tax_total using errcode = 'ZZ999';
  end if;
  if v_s.total <> 50.00 or v_s.subtotal <> 50.00 then
    raise exception 'TEST FAILED: zero-rated totals wrong (subtotal %, total %)', v_s.subtotal, v_s.total
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a zero-rated item is untaxed and totals 50.00';
end $$;

-- ── 3. Not enough cash: nothing is written ───────────────────────────────

do $$
declare v_before int; v_after int; v_stock_before numeric; v_stock_after numeric;
begin
  select count(*) into v_before from sales;
  select quantity into v_stock_before from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);

  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 10,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
    );
    raise exception 'TEST FAILED: a sale completed with less cash than the total' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: insufficient cash rejected';
  end;

  select count(*) into v_after from sales;
  select quantity into v_stock_after from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);

  if v_after <> v_before then
    raise exception 'TEST FAILED: the rejected sale left a row behind' using errcode = 'ZZ999';
  end if;
  if v_stock_after is distinct from v_stock_before then
    raise exception 'TEST FAILED: the rejected sale still moved stock (% -> %)', v_stock_before, v_stock_after
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: the rejected sale left no row and no stock movement';
end $$;

-- ── 4. Overselling is blocked, and rolls the whole sale back ─────────────

do $$
declare v_before int; v_stock_before numeric; v_stock_after numeric;
begin
  select count(*) into v_before from sales;
  select quantity into v_stock_before from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);

  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 100000,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 999))
    );
    raise exception 'TEST FAILED: sold 999 of an item with 19 in stock' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: overselling refused (allow_negative_stock is false)';
  end;

  select quantity into v_stock_after from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);
  if v_stock_after is distinct from v_stock_before then
    raise exception 'TEST FAILED: refused oversale still changed stock' using errcode = 'ZZ999';
  end if;
  if (select count(*) from sales) <> v_before then
    raise exception 'TEST FAILED: refused oversale left a sale row' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: the refused oversale rolled back completely';
end $$;

-- ── 5. A multi-line sale where only the LAST line oversells ──────────────
-- The interesting case: the earlier lines succeed, then the sale fails.
-- Every one of them must be undone.

do $$
declare v_before int; v_bread_before numeric; v_bread_after numeric;
begin
  select count(*) into v_before from sales;
  select quantity into v_bread_before from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select bread from s_ids);

  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 100000,
      jsonb_build_array(
        jsonb_build_object('variant_id', (select bread from s_ids), 'quantity', 2),
        jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 999)
      )
    );
    raise exception 'TEST FAILED: a sale completed despite its second line overselling' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a sale failing on its second line is rejected';
  end;

  select quantity into v_bread_after from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select bread from s_ids);
  if v_bread_after is distinct from v_bread_before then
    raise exception 'TEST FAILED: the FIRST line''s stock was not rolled back (% -> %)',
      v_bread_before, v_bread_after using errcode = 'ZZ999';
  end if;
  if (select count(*) from sales) <> v_before then
    raise exception 'TEST FAILED: a partial sale row survived' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: the successful first line was rolled back with the rest';
end $$;

-- ── 6. Credit sales post to the customer ledger ──────────────────────────

do $$
declare v_cust uuid; v_sale uuid; v_balance numeric; v_total numeric;
begin
  insert into customers (business_id, name, phone, credit_limit)
  select biz_a, 'Till Credit Customer', '0201112223', 500 from s_ids
  returning id into v_cust;

  select create_sale(
    (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', v_cust, 'credit', 0,
    jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 2))
  ) into v_sale;

  select total into v_total from sales where id = v_sale;
  select balance into v_balance from customer_balances where customer_id = v_cust;

  if v_balance is distinct from v_total then
    raise exception 'TEST FAILED: balance % does not match the sale total %', v_balance, v_total
      using errcode = 'ZZ999';
  end if;
  if not exists (
    select 1 from customer_account_entries
    where reference_type = 'sale' and reference_id = v_sale and entry_type = 'sale'
  ) then
    raise exception 'TEST FAILED: no account entry linked back to the sale' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a credit sale of % lands on the customer''s account', v_total;
end $$;

-- ── 7. A credit sale needs a customer ────────────────────────────────────

do $$
begin
  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'credit', 0,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
    );
    raise exception 'TEST FAILED: a credit sale completed with no customer' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a credit sale without a customer is refused';
  end;
end $$;

-- ── 8. The credit limit stops a sale, and rolls it all back ──────────────

do $$
declare v_cust uuid; v_before int; v_stock_before numeric; v_stock_after numeric; v_balance numeric;
begin
  insert into customers (business_id, name, credit_limit)
  select biz_a, 'Tight Limit Customer', 50 from s_ids returning id into v_cust;

  select count(*) into v_before from sales;
  select quantity into v_stock_before from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);

  begin
    -- 2 x 100.00 = 200.00 against a 50.00 limit.
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', v_cust, 'credit', 0,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 2))
    );
    raise exception 'TEST FAILED: a credit sale exceeded the customer''s limit' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a credit sale over the limit is refused';
  end;

  select quantity into v_stock_after from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);

  -- This is the important half: the stock had already been decremented
  -- inside the transaction before the limit check fired.
  if v_stock_after is distinct from v_stock_before then
    raise exception 'TEST FAILED: the refused credit sale still took stock (% -> %)',
      v_stock_before, v_stock_after using errcode = 'ZZ999';
  end if;
  if (select count(*) from sales) <> v_before then
    raise exception 'TEST FAILED: the refused credit sale left a sale row' using errcode = 'ZZ999';
  end if;
  select balance into v_balance from customer_balances where customer_id = v_cust;
  if coalesce(v_balance, 0) <> 0 then
    raise exception 'TEST FAILED: the refused credit sale moved the balance to %', v_balance using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: the over-limit sale rolled back stock, sale and balance together';
end $$;

-- ── 9. An archived product cannot be sold ────────────────────────────────

do $$
declare v_v uuid;
begin
  select bread into v_v from s_ids;
  update product_variants set status = 'archived' where id = v_v;

  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 1000,
      jsonb_build_array(jsonb_build_object('variant_id', v_v, 'quantity', 1))
    );
    raise exception 'TEST FAILED: an archived product was sold' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: an archived product cannot be sold';
  end;

  update product_variants set status = 'active' where id = v_v;
end $$;

-- ── 10. Receipt numbers increment ────────────────────────────────────────

do $$
declare v_sale uuid; v_ref text; v_n int;
begin
  select create_sale(
    (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 1000,
    jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
  ) into v_sale;
  select receipt_number into v_ref from sales where id = v_sale;
  select count(*) into v_n from sales;
  if v_ref <> 'R-' || lpad(v_n::text, 6, '0') then
    raise exception 'TEST FAILED: receipt % does not follow the sequence at % sales', v_ref, v_n
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: receipt numbers increment per business (%)', v_ref;
end $$;

-- ── 11. A completed sale is not editable ─────────────────────────────────

do $$
begin
  begin
    update sales set total = 1;
    raise exception 'TEST FAILED: a sale was UPDATEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: UPDATE on sales refused (grant revoked)';
  end;

  begin
    delete from sales;
    raise exception 'TEST FAILED: a sale was DELETEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: DELETE on sales refused (grant revoked)';
  end;

  begin
    update sale_items set quantity = 99;
    raise exception 'TEST FAILED: a sale line was UPDATEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: UPDATE on sale_items refused (grant revoked)';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 12. Without sales.process, no sale ───────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000096';

do $$
begin
  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000096', null, 'cash', 1000,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
    );
    raise exception 'TEST FAILED: an auditor rang up a sale' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a role without sales.process cannot sell';
  end;

  -- 0020 opened 'sale' movements and 'sale' account entries, which 0015
  -- and 0017 had reserved. They are gated on sales.process, not simply
  -- unlocked — this is the half of that rule those suites used to cover.
  begin
    insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
    select branch_a, soap, -1, 'sale' from s_ids;
    raise exception 'TEST FAILED: a role without sales.process wrote a "sale" stock movement'
      using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a "sale" movement still needs sales.process';
  end;

  begin
    insert into customer_account_entries (customer_id, amount, entry_type)
    select id, 10, 'sale' from customers where name = 'Till Credit Customer';
    raise exception 'TEST FAILED: a role without sales.process wrote a "sale" account entry'
      using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a "sale" account entry still needs sales.process';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 13. Cross-tenant isolation ───────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000046';

do $$
declare v_seen int;
begin
  select count(*) into v_seen from sales;
  if v_seen <> 0 then
    raise exception 'TEST FAILED: business F saw % of business A''s sales', v_seen using errcode = 'ZZ999';
  end if;

  -- Business A's product, sold into business F's own branch.
  begin
    perform create_sale(
      (select branch_f from s_ids), null, null, 'cash', 1000,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
    );
    raise exception 'TEST FAILED: business F sold business A''s product' using errcode = 'ZZ999';
  exception when sqlstate 'P0002' then
    raise notice 'PASS: another tenant''s product cannot be sold';
  end;

  raise notice 'PASS: business F sees none of business A''s sales';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 13b. A sale can only ever be attributed to whoever is signed in (0039) ──
-- create_sale() keeps the p_cashier_id parameter (so nothing needed a new
-- overload), but it is no longer trusted for the insert: naming anyone but
-- the caller is a hard 42501, and null falls back to auth.uid() — exactly
-- what the till UI sends now (app/(app)/till/actions.ts no longer reads a
-- till-session cashier id at all).

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_sale uuid;
begin
  -- Naming a DIFFERENT real, valid account is refused outright, even
  -- though that account genuinely exists in this same business.
  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000096', null, 'cash', 1000,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
    );
    raise exception 'TEST FAILED: a sale was attributed to an account other than the caller'
      using errcode = 'ZZ999';
  exception when sqlstate '42501' then
    raise notice 'PASS: create_sale() refuses a p_cashier_id that is not the caller''s own';
  end;

  -- null (what the till actually sends) falls back to whoever is signed in.
  select create_sale(
    (select branch_a from s_ids), null, null, 'cash', 1000,
    jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
  ) into v_sale;

  if (select cashier_id from sales where id = v_sale) <> '00000000-0000-0000-0000-000000000001' then
    raise exception 'TEST FAILED: a null p_cashier_id did not fall back to the caller' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a null p_cashier_id attributes the sale to the caller';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 13c. allow_negative_stock is honoured, not just declared ─────────────
-- 0020 made the negative-stock rule read business_settings rather than
-- being hardcoded. That claim is only worth anything if the other branch
-- actually works, so both settings are exercised.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_stock_before numeric; v_stock_after numeric; v_sale uuid;
begin
  select quantity into v_stock_before from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);

  perform set_config('busihub.privileged_write', 'on', true);
  update business_settings
  set pos_settings = jsonb_set(pos_settings, '{allow_negative_stock}', 'true'::jsonb)
  where business_id = (select biz_a from s_ids);
  perform set_config('busihub.privileged_write', 'off', true);

  -- More than is on hand: now permitted, and the level goes negative.
  select create_sale(
    (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 1000000,
    jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids),
                                         'quantity', v_stock_before + 5))
  ) into v_sale;

  select quantity into v_stock_after from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);

  if v_stock_after <> -5 then
    raise exception 'TEST FAILED: expected -5 on hand once negatives are allowed, got %', v_stock_after
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: with allow_negative_stock on, the sale completes and stock goes to -5';

  -- Put it back, and confirm the block returns.
  perform set_config('busihub.privileged_write', 'on', true);
  update business_settings
  set pos_settings = jsonb_set(pos_settings, '{allow_negative_stock}', 'false'::jsonb)
  where business_id = (select biz_a from s_ids);
  perform set_config('busihub.privileged_write', 'off', true);

  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 1000,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
    );
    raise exception 'TEST FAILED: selling below zero was still allowed after turning the setting off'
      using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: turning the setting off restores the block';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 14. Everything still reconciles ──────────────────────────────────────

do $$
declare v_stock_mismatch int; v_bal_mismatch int; v_sale_mismatch int;
begin
  select count(*) into v_stock_mismatch
  from stock_levels s
  where s.quantity is distinct from (
    select coalesce(sum(m.quantity_delta), 0) from inventory_movements m
    where m.branch_id = s.branch_id and m.variant_id = s.variant_id);

  select count(*) into v_bal_mismatch
  from customer_balances b
  where b.balance is distinct from (
    select coalesce(sum(e.amount), 0) from customer_account_entries e
    where e.customer_id = b.customer_id);

  -- Each sale's stored totals must equal the sum of its own lines.
  select count(*) into v_sale_mismatch
  from sales s
  where (s.subtotal, s.tax_total, s.total) is distinct from (
    select (coalesce(sum(i.line_subtotal), 0), coalesce(sum(i.line_tax), 0), coalesce(sum(i.line_total), 0))
    from sale_items i where i.sale_id = s.id);

  if v_stock_mismatch <> 0 then
    raise exception 'TEST FAILED: % stock level(s) disagree with the ledger', v_stock_mismatch using errcode = 'ZZ999';
  end if;
  if v_bal_mismatch <> 0 then
    raise exception 'TEST FAILED: % balance(s) disagree with the ledger', v_bal_mismatch using errcode = 'ZZ999';
  end if;
  if v_sale_mismatch <> 0 then
    raise exception 'TEST FAILED: % sale(s) disagree with their own lines', v_sale_mismatch using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: stock, balances and sale totals all reconcile';
end $$;

-- ── sales_summary: the takings line on the history page ─────────────────
--
-- A total on a money screen is either right or worse than useless, and
-- this one is computed in the database precisely so it covers the whole
-- filtered period rather than one page of it (migration 0027). Two things
-- have to hold: it counts only sales that were actually paid for, and it
-- is bounded by the same RLS as the list it sits above.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare
  v_row record; v_completed numeric; v_refunded numeric; v_count bigint;
begin
  select * into v_row from sales_summary();

  select count(*), coalesce(sum(total), 0) into v_count, v_completed
  from sales where status = 'completed';
  select coalesce(sum(r.total), 0) into v_refunded
  from refunds r join sales s on s.id = r.sale_id where s.status = 'completed';

  if v_row.sale_count <> v_count then
    raise exception 'TEST FAILED: summary counted %, expected %', v_row.sale_count, v_count using errcode = 'ZZ999';
  end if;
  if v_row.gross_total <> v_completed then
    raise exception 'TEST FAILED: summary gross %, expected %', v_row.gross_total, v_completed using errcode = 'ZZ999';
  end if;
  if v_row.refunded_total <> v_refunded then
    raise exception 'TEST FAILED: summary refunded %, expected %', v_row.refunded_total, v_refunded
      using errcode = 'ZZ999';
  end if;
  if v_row.net_total <> v_completed - v_refunded then
    raise exception 'TEST FAILED: net % does not equal gross minus refunds', v_row.net_total using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: the takings line equals completed sales less what was returned';

  -- A sale still waiting for mobile money has not been paid for. It stays
  -- in the LIST — that is the point of a history — but counting it as
  -- takings would overstate the day, silently, which is the dangerous
  -- kind of wrong. Made here rather than assumed from another suite, so
  -- this holds whatever order the suites run in.
  declare
    v_unpaid uuid; v_after record;
  begin
    -- Earlier assertions in this suite deliberately sell the shelf down,
    -- so put one back before ringing this up.
    insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
    select branch_a, soap, 10, 'receive' from s_ids;

    select create_sale((select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, null, null,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1)),
      jsonb_build_array(jsonb_build_object(
        'method', 'momo', 'momo_number', '0244123456', 'momo_network', 'mtn'))
    ) into v_unpaid;

    if (select status from sales where id = v_unpaid) <> 'awaiting_payment' then
      raise exception 'TEST FIXTURE BROKEN: the momo sale did not end up awaiting payment' using errcode = 'ZZ999';
    end if;

    select * into v_after from sales_summary();
    if v_after.sale_count <> v_row.sale_count or v_after.gross_total <> v_row.gross_total then
      raise exception 'TEST FAILED: an unpaid sale was counted as takings (% -> %)',
        v_row.gross_total, v_after.gross_total using errcode = 'ZZ999';
    end if;
    raise notice 'PASS: a sale still waiting for payment is listed but not counted as takings';
  end;

  -- A window with nothing in it is zero, not null — a blank card on the
  -- page would read as "broken" rather than "no sales that day".
  select * into v_row from sales_summary('1990-01-01'::timestamptz, '1990-01-02'::timestamptz);
  if v_row.sale_count <> 0 or v_row.gross_total <> 0 or v_row.net_total <> 0 then
    raise exception 'TEST FAILED: an empty period is not zero' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a period with no sales totals zero rather than null';
end $$;

reset role;
reset request.jwt.claim.sub;

-- The other business's owner must not be able to total our takings. The
-- function is SECURITY INVOKER for exactly this reason; if it were ever
-- changed to DEFINER, this is the assertion that should fail.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000046';

do $$
declare v_row record; v_theirs numeric;
begin
  select * into v_row from sales_summary();

  select coalesce(sum(s.total), 0) into v_theirs
  from sales s where s.status = 'completed' and s.business_id = (select biz_f from s_ids);

  if v_row.gross_total <> v_theirs then
    raise exception 'TEST FAILED: business F totalled % but owns only %', v_row.gross_total, v_theirs
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: the takings line is bounded by RLS — each shop totals only its own sales';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── dashboard_snapshot: the numbers on the front page ───────────────────
--
-- Totals over whole tables, so they are computed in the database for the
-- same reason as the takings line. The one that matters most here is the
-- last: a shopkeeper opening the app must never be shown another shop's
-- debts.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_snap record; v_owed numeric; v_waiting bigint;
begin
  select * into v_snap from dashboard_snapshot();

  select coalesce(sum(balance), 0) into v_owed from customer_balances where balance > 0;
  if v_snap.owed_total <> v_owed then
    raise exception 'TEST FAILED: owed % but customers owe %', v_snap.owed_total, v_owed using errcode = 'ZZ999';
  end if;

  select count(*) into v_waiting from sales where status = 'awaiting_payment';
  if v_snap.awaiting_payment_count <> v_waiting then
    raise exception 'TEST FAILED: % sales waiting, snapshot says %', v_waiting, v_snap.awaiting_payment_count
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: the dashboard counts match the tables they summarise';

  -- A customer in credit must not reduce what everybody else owes. If
  -- balances were summed unconditionally, one refunded customer would
  -- silently understate the shop's debtors.
  if exists (select 1 from customer_balances where balance < 0) then
    if v_snap.owed_total <> (select coalesce(sum(balance), 0) from customer_balances where balance > 0) then
      raise exception 'TEST FAILED: a customer in credit is offsetting the debts' using errcode = 'ZZ999';
    end if;
    raise notice 'PASS: a customer in credit does not reduce what others owe';
  else
    raise notice 'PASS: (no customer in credit to check offsetting against)';
  end if;
end $$;

reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000046';

do $$
declare v_snap record; v_theirs numeric;
begin
  select * into v_snap from dashboard_snapshot();

  select coalesce(sum(b.balance), 0) into v_theirs
  from customer_balances b
  join customers c on c.id = b.customer_id
  where b.balance > 0 and c.business_id = (select biz_f from s_ids);

  if v_snap.owed_total <> v_theirs then
    raise exception 'TEST FAILED: business F sees % owed but is owed %', v_snap.owed_total, v_theirs
      using errcode = 'ZZ999';
  end if;
  if v_snap.awaiting_payment_count <> (select count(*) from sales where business_id = (select biz_f from s_ids)
                                        and status = 'awaiting_payment') then
    raise exception 'TEST FAILED: business F is counting another shop''s unpaid sales' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: the dashboard is bounded by RLS — no shop sees another shop''s debts';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── cost of goods: recorded once, at the moment of sale ─────────────────
--
-- The whole reason 0029 exists. If the cost were read from the catalog
-- when a report runs, a supplier raising their price next week would
-- silently rewrite this week's profit. These assertions are what stop
-- that being reintroduced.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare
  v_sale uuid; v_item record; v_variant uuid; v_cost_then numeric;
  v_before record; v_after record; v_refund uuid; v_ritem record;
begin
  select soap into v_variant from s_ids;

  insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
  select branch_a, soap, 20, 'receive' from s_ids;

  select cost_price into v_cost_then from product_variants where id = v_variant;
  if coalesce(v_cost_then, 0) <= 0 then
    raise exception 'TEST FIXTURE BROKEN: the fixture variant has no cost price' using errcode = 'ZZ999';
  end if;

  select create_sale((select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 1000,
    jsonb_build_array(jsonb_build_object('variant_id', v_variant, 'quantity', 4))) into v_sale;

  select * into v_item from sale_items where sale_id = v_sale;
  if v_item.unit_cost <> v_cost_then then
    raise exception 'TEST FAILED: sale recorded a cost of %, catalog said %', v_item.unit_cost, v_cost_then
      using errcode = 'ZZ999';
  end if;
  if v_item.cost_is_estimated then
    raise exception 'TEST FAILED: a sale rung up now was marked as an estimated cost' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a sale records what the goods cost at the moment they were sold';

  -- Now the supplier puts the price up. Last week's profit must not move.
  select * into v_before from sales_summary();

  update product_variants set cost_price = v_cost_then * 3 where id = v_variant;

  if (select unit_cost from sale_items where id = v_item.id) <> v_cost_then then
    raise exception 'TEST FAILED: changing the catalog cost rewrote a past sale' using errcode = 'ZZ999';
  end if;

  select * into v_after from sales_summary();
  if v_after.cost_total <> v_before.cost_total or v_after.gross_profit <> v_before.gross_profit then
    raise exception 'TEST FAILED: a cost change moved past profit (% -> %)',
      v_before.gross_profit, v_after.gross_profit using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: raising a supplier price does not rewrite the profit on sales already made';

  -- Put it back so later assertions see the fixture they expect.
  update product_variants set cost_price = v_cost_then where id = v_variant;

  -- A return takes its own cost back out, not today's.
  select create_refund(v_sale, '00000000-0000-0000-0000-000000000001', 'cash', null,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item.id, 'quantity', 2, 'restock', true))) into v_refund;

  select * into v_ritem from refund_items where refund_id = v_refund;
  if v_ritem.unit_cost <> v_cost_then then
    raise exception 'TEST FAILED: the return carried a cost of %, the sale line said %',
      v_ritem.unit_cost, v_cost_then using errcode = 'ZZ999';
  end if;

  select * into v_after from sales_summary();
  if v_after.cost_total <> v_before.cost_total - (2 * v_cost_then) then
    raise exception 'TEST FAILED: returning 2 units did not remove their cost (% -> %)',
      v_before.cost_total, v_after.cost_total using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a return removes the cost it added, not the current catalog cost';

  -- And the headline figure has to be internally consistent.
  if abs(v_after.gross_profit - (v_after.net_total - v_after.cost_total)) > 0.005 then
    raise exception 'TEST FAILED: gross profit % is not net % less cost %',
      v_after.gross_profit, v_after.net_total, v_after.cost_total using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: gross profit equals net sales less the cost of what was actually sold';
end $$;

reset role;
reset request.jwt.claim.sub;

\echo ''
\echo 'All sales tests passed.'