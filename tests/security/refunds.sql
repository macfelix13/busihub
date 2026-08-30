-- Busihub — behaviour/security test for refunds & voids (migration 0021).
--
-- The money here is apportioned from an ORIGINAL sale, so the assertions
-- concentrate on two things: that a customer is refunded what they
-- actually paid (never a recomputed price), and that a rejected
-- correction leaves nothing behind.
--
-- `TEST FAILED` raises carry SQLSTATE ZZ999, which no handler catches.

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000095',
        'authenticated', 'authenticated', 'tillonly@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select create_product(
  (select id from businesses where slug = 'busihub-demo-store'),
  'Refund Test Rice', null, 'Grains', 'each', 'standard',
  '{}'::text[],
  '[{"sku": "RRICE-1", "barcode": "", "variant_options": {}, "cost_price": 30, "selling_price": 60}]'::jsonb
);
reset role;
reset request.jwt.claim.sub;

create table r_ids as
select
  (select id from businesses where slug = 'busihub-demo-store') as biz_a,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'busihub-demo-store') and b.is_main) as branch_a,
  (select id from product_variants where sku = 'RRICE-1') as rice;

do $$
declare r record;
begin
  select * into r from r_ids;
  if r.biz_a is null or r.branch_a is null or r.rice is null then
    raise exception 'TEST FIXTURE BROKEN: r_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

grant select on r_ids to authenticated;

-- A Cashier: sales.process but NOT sales.void or sales.refund. That split
-- is the whole point of the permissions, so the fixture guards it.
do $$
declare v_biz uuid; v_branch uuid; v_role uuid;
begin
  select biz_a, branch_a into v_biz, v_branch from r_ids;
  select id into v_role from roles where business_id = v_biz and name = 'Cashier';

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000095', v_biz, 'Till', 'Only', 'tillonly@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000000095', v_role,
            '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;

  if exists (
    select 1 from role_permissions rp join permissions p on p.id = rp.permission_id
    where rp.role_id = v_role and p.key in ('sales.void', 'sales.refund')
  ) then
    raise exception 'TEST FIXTURE BROKEN: Cashier unexpectedly holds sales.void/refund' using errcode = 'ZZ999';
  end if;
end $$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
select branch_a, rice, 100, 'receive' from r_ids;

-- ── 1. A partial refund gives back what was actually paid ────────────────

do $$
declare
  v_sale uuid; v_item uuid; v_refund uuid; v_r record; v_line record;
  v_stock_before numeric; v_stock_after numeric; v_sale_total numeric;
begin
  -- Sell 5 at 60.00 = 300.00 (tax-inclusive).
  select create_sale(
    (select branch_a from r_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 300,
    jsonb_build_array(jsonb_build_object('variant_id', (select rice from r_ids), 'quantity', 5))
  ) into v_sale;

  select total into v_sale_total from sales where id = v_sale;
  select id into v_item from sale_items where sale_id = v_sale;
  select quantity into v_stock_before from stock_levels
  where branch_id = (select branch_a from r_ids) and variant_id = (select rice from r_ids);

  -- Two of the five come back.
  select create_refund(v_sale, '00000000-0000-0000-0000-000000000001', 'cash', 'Wrong size',
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 2, 'restock', true))
  ) into v_refund;

  select * into v_r from refunds where id = v_refund;

  if v_r.refund_number <> 'RF-000001' then
    raise exception 'TEST FAILED: expected RF-000001, got %', v_r.refund_number using errcode = 'ZZ999';
  end if;

  -- Two fifths of 300.00. Apportioned from the sale, not recomputed.
  if v_r.total <> 120.00 then
    raise exception 'TEST FAILED: refunding 2 of 5 from a 300.00 sale should be 120.00, got %', v_r.total
      using errcode = 'ZZ999';
  end if;
  -- The parts must still sum to the whole, as they do on a sale.
  if v_r.subtotal + v_r.tax_total <> v_r.total then
    raise exception 'TEST FAILED: % + % <> %', v_r.subtotal, v_r.tax_total, v_r.total using errcode = 'ZZ999';
  end if;
  if v_r.tax_total <= 0 then
    raise exception 'TEST FAILED: a standard-rated refund carried no tax' using errcode = 'ZZ999';
  end if;

  select quantity into v_stock_after from stock_levels
  where branch_id = (select branch_a from r_ids) and variant_id = (select rice from r_ids);
  if v_stock_after <> v_stock_before + 2 then
    raise exception 'TEST FAILED: expected 2 back in stock (% -> %)', v_stock_before, v_stock_after
      using errcode = 'ZZ999';
  end if;

  -- The sale itself is untouched — that is the point of refunds being
  -- their own rows.
  if (select total from sales where id = v_sale) <> v_sale_total then
    raise exception 'TEST FAILED: the refund altered the original sale total' using errcode = 'ZZ999';
  end if;
  if (select status from sales where id = v_sale) <> 'completed' then
    raise exception 'TEST FAILED: the refund changed the sale status' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: 2 of 5 refunded for % (tax %), 2 back in stock, sale untouched', v_r.total, v_r.tax_total;
end $$;

-- ── 2. Refunds accumulate: you cannot give back more than was sold ───────

do $$
declare v_sale uuid; v_item uuid; v_stock_before numeric; v_stock_after numeric; v_count int;
begin
  select id into v_sale from sales where receipt_number = (select max(receipt_number) from sales);
  select id into v_item from sale_items where sale_id = v_sale;
  select quantity into v_stock_before from stock_levels
  where branch_id = (select branch_a from r_ids) and variant_id = (select rice from r_ids);
  select count(*) into v_count from refunds;

  -- 2 already back; asking for 4 more of 5 must fail.
  begin
    perform create_refund(v_sale, '00000000-0000-0000-0000-000000000001', 'cash', null,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 4, 'restock', true)));
    raise exception 'TEST FAILED: refunded more than was sold' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: refunding beyond the quantity sold is refused (%)', sqlerrm;
  end;

  select quantity into v_stock_after from stock_levels
  where branch_id = (select branch_a from r_ids) and variant_id = (select rice from r_ids);
  if v_stock_after is distinct from v_stock_before then
    raise exception 'TEST FAILED: the refused refund still moved stock' using errcode = 'ZZ999';
  end if;
  if (select count(*) from refunds) <> v_count then
    raise exception 'TEST FAILED: the refused refund left a row behind' using errcode = 'ZZ999';
  end if;

  -- The remaining 3 are fine.
  perform create_refund(v_sale, '00000000-0000-0000-0000-000000000001', 'cash', null,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 3, 'restock', true)));

  if sale_item_refunded_quantity(v_item) <> 5 then
    raise exception 'TEST FAILED: expected 5 refunded in total, got %', sale_item_refunded_quantity(v_item)
      using errcode = 'ZZ999';
  end if;

  -- And now nothing is left.
  begin
    perform create_refund(v_sale, '00000000-0000-0000-0000-000000000001', 'cash', null,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 1, 'restock', true)));
    raise exception 'TEST FAILED: refunded a line that was already fully returned' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a fully refunded line has nothing left to give back';
  end;

  raise notice 'PASS: refunds accumulate across separate returns (2 then 3 of 5)';
end $$;

-- ── 3. Damaged goods are refunded but not restocked ──────────────────────

do $$
declare v_sale uuid; v_item uuid; v_refund uuid; v_stock_before numeric; v_stock_after numeric;
begin
  select create_sale(
    (select branch_a from r_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 200,
    jsonb_build_array(jsonb_build_object('variant_id', (select rice from r_ids), 'quantity', 2))
  ) into v_sale;

  select id into v_item from sale_items where sale_id = v_sale;
  select quantity into v_stock_before from stock_levels
  where branch_id = (select branch_a from r_ids) and variant_id = (select rice from r_ids);

  select create_refund(v_sale, '00000000-0000-0000-0000-000000000001', 'cash', 'Damaged',
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 1, 'restock', false))
  ) into v_refund;

  select quantity into v_stock_after from stock_levels
  where branch_id = (select branch_a from r_ids) and variant_id = (select rice from r_ids);

  if v_stock_after is distinct from v_stock_before then
    raise exception 'TEST FAILED: damaged goods went back on the shelf (% -> %)', v_stock_before, v_stock_after
      using errcode = 'ZZ999';
  end if;
  if (select total from refunds where id = v_refund) <> 60.00 then
    raise exception 'TEST FAILED: the customer was not refunded for damaged goods' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: damaged goods are refunded (60.00) without returning to stock';
end $$;

-- ── 4. Voiding a sale reverses everything ────────────────────────────────

do $$
declare v_sale uuid; v_stock_before numeric; v_stock_after numeric; v_status text;
begin
  select quantity into v_stock_before from stock_levels
  where branch_id = (select branch_a from r_ids) and variant_id = (select rice from r_ids);

  select create_sale(
    (select branch_a from r_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 600,
    jsonb_build_array(jsonb_build_object('variant_id', (select rice from r_ids), 'quantity', 4))
  ) into v_sale;

  perform void_sale(v_sale, 'Rung up twice');

  select status into v_status from sales where id = v_sale;
  select quantity into v_stock_after from stock_levels
  where branch_id = (select branch_a from r_ids) and variant_id = (select rice from r_ids);

  if v_status <> 'voided' then
    raise exception 'TEST FAILED: expected voided, got %', v_status using errcode = 'ZZ999';
  end if;
  if v_stock_after is distinct from v_stock_before then
    raise exception 'TEST FAILED: voiding did not put the stock back (% -> %)', v_stock_before, v_stock_after
      using errcode = 'ZZ999';
  end if;

  -- Terminal in both directions.
  begin
    perform void_sale(v_sale, null);
    raise exception 'TEST FAILED: a voided sale was voided again' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a voided sale cannot be voided twice';
  end;

  begin
    update sales set status = 'completed' where id = v_sale;
    raise exception 'TEST FAILED: a voided sale was restored to completed' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a voided sale cannot be un-voided';
  end;

  raise notice 'PASS: voiding reverses the stock and marks the sale voided';
end $$;

-- ── 5. Void and refund are mutually exclusive ────────────────────────────

do $$
declare v_sale uuid; v_item uuid;
begin
  select create_sale(
    (select branch_a from r_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 200,
    jsonb_build_array(jsonb_build_object('variant_id', (select rice from r_ids), 'quantity', 2))
  ) into v_sale;
  select id into v_item from sale_items where sale_id = v_sale;

  perform create_refund(v_sale, '00000000-0000-0000-0000-000000000001', 'cash', null,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 1, 'restock', true)));

  -- Voiding now would reverse the whole sale on top of the refund that
  -- already reversed part of it.
  begin
    perform void_sale(v_sale, null);
    raise exception 'TEST FAILED: voided a sale that had already been refunded' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a partly refunded sale cannot be voided (no double reversal)';
  end;
end $$;

-- ── 6. A voided sale has nothing left to refund ──────────────────────────

do $$
declare v_sale uuid; v_item uuid;
begin
  select create_sale(
    (select branch_a from r_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 100,
    jsonb_build_array(jsonb_build_object('variant_id', (select rice from r_ids), 'quantity', 1))
  ) into v_sale;
  select id into v_item from sale_items where sale_id = v_sale;

  perform void_sale(v_sale, null);

  begin
    perform create_refund(v_sale, '00000000-0000-0000-0000-000000000001', 'cash', null,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 1, 'restock', true)));
    raise exception 'TEST FAILED: refunded a voided sale' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a voided sale cannot also be refunded';
  end;
end $$;

-- ── 7. Refunding an on-account sale credits the account ──────────────────

do $$
declare v_cust uuid; v_sale uuid; v_item uuid; v_balance_after_sale numeric; v_balance_final numeric;
begin
  insert into customers (business_id, name, credit_limit)
  select biz_a, 'Refund Account Customer', 1000 from r_ids returning id into v_cust;

  select create_sale(
    (select branch_a from r_ids), '00000000-0000-0000-0000-000000000001', v_cust, 'credit', 0,
    jsonb_build_array(jsonb_build_object('variant_id', (select rice from r_ids), 'quantity', 3))
  ) into v_sale;

  select balance into v_balance_after_sale from customer_balances where customer_id = v_cust;
  if v_balance_after_sale <> 180.00 then
    raise exception 'TEST FAILED: expected 180.00 owing, got %', v_balance_after_sale using errcode = 'ZZ999';
  end if;

  select id into v_item from sale_items where sale_id = v_sale;
  perform create_refund(v_sale, '00000000-0000-0000-0000-000000000001', 'credit', 'Changed mind',
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 1, 'restock', true)));

  select balance into v_balance_final from customer_balances where customer_id = v_cust;
  if v_balance_final <> 120.00 then
    raise exception 'TEST FAILED: expected 120.00 owing after refunding one, got %', v_balance_final
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: refunding one of three on account takes the balance 180.00 -> 120.00';
end $$;

-- ── 8. A walk-in sale cannot be refunded onto an account ─────────────────

do $$
declare v_sale uuid; v_item uuid;
begin
  select create_sale(
    (select branch_a from r_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 100,
    jsonb_build_array(jsonb_build_object('variant_id', (select rice from r_ids), 'quantity', 1))
  ) into v_sale;
  select id into v_item from sale_items where sale_id = v_sale;

  begin
    perform create_refund(v_sale, '00000000-0000-0000-0000-000000000001', 'credit', null,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 1, 'restock', true)));
    raise exception 'TEST FAILED: credited an account on a walk-in sale' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a walk-in sale can only be refunded in cash';
  end;
end $$;

-- ── 9. A refund cannot be edited away ────────────────────────────────────

do $$
begin
  begin
    update refunds set total = 1;
    raise exception 'TEST FAILED: a refund was UPDATEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: UPDATE on refunds refused (grant revoked)';
  end;

  begin
    delete from refunds;
    raise exception 'TEST FAILED: a refund was DELETEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: DELETE on refunds refused (grant revoked)';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 10. A cashier can sell but not undo ──────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000095';

do $$
declare v_sale uuid; v_item uuid; v_rows int; v_status text;
begin
  -- They can ring one up.
  select create_sale(
    (select branch_a from r_ids), '00000000-0000-0000-0000-000000000095', null, 'cash', 100,
    jsonb_build_array(jsonb_build_object('variant_id', (select rice from r_ids), 'quantity', 1))
  ) into v_sale;
  select id into v_item from sale_items where sale_id = v_sale;
  raise notice 'PASS: a cashier can ring up a sale';

  begin
    perform create_refund(v_sale, '00000000-0000-0000-0000-000000000095', 'cash', null,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 1, 'restock', true)));
    raise exception 'TEST FAILED: a cashier refunded without sales.refund' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a cashier cannot refund';
  end;

  -- void_sale now checks sales.void up front and raises 42501, rather
  -- than reaching the UPDATE and having RLS silently match zero rows
  -- AFTER the stock reversals were already written. Both the error AND
  -- the untouched data are asserted, because the silent-partial-void is
  -- the failure that actually matters.
  begin
    perform void_sale(v_sale, null);
    raise exception 'TEST FAILED: a cashier voided a sale without sales.void' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a cashier cannot void a sale';
  end;

  if (select status from sales where id = v_sale) <> 'completed' then
    raise exception 'TEST FAILED: the refused void changed the sale status' using errcode = 'ZZ999';
  end if;
  if exists (select 1 from inventory_movements where reference_type = 'sale_void' and reference_id = v_sale) then
    raise exception 'TEST FAILED: the refused void still put stock back' using errcode = 'ZZ999';
  end if;

  -- Nor by writing the stock back by hand.
  begin
    insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
    select branch_a, rice, 1, 'sale_refund' from r_ids;
    raise exception 'TEST FAILED: a cashier wrote a refund stock movement' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: putting stock back still needs sales.refund';
  end;

  -- Nor by crediting the account by hand. This is the half of the rule
  -- customers.sql used to cover as "reserved until the refunds phase".
  begin
    insert into customer_account_entries (customer_id, amount, entry_type)
    select id, -10, 'refund' from customers where name = 'Refund Account Customer';
    raise exception 'TEST FAILED: a cashier credited an account with a refund entry' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: crediting an account back still needs sales.refund';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 10b. Nothing selected vs. a give-away line ───────────────────────────
--
-- These two cases look identical if you guard the empty return by testing
-- the total, and they are not: a promotional line sold at 0.00 refunds no
-- money but still has to come back onto the shelf. The guard counts lines
-- instead, and `refunds.total` allows 0.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

select create_product(
  (select biz_a from r_ids),
  'Refund Test Free Sachet', null, 'Promo', 'each', 'standard',
  '{}'::text[],
  '[{"sku": "RFREE-1", "barcode": "", "variant_options": {}, "cost_price": 0, "selling_price": 0}]'::jsonb
);

insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
select branch_a, (select id from product_variants where sku = 'RFREE-1'), 10, 'receive' from r_ids;

do $$
declare
  v_free uuid; v_sale uuid; v_item uuid; v_refund uuid;
  v_before numeric; v_after numeric; v_count int; v_entries int;
begin
  select id into v_free from product_variants where sku = 'RFREE-1';

  select create_sale((select branch_a from r_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 0,
    jsonb_build_array(jsonb_build_object('variant_id', v_free, 'quantity', 3))) into v_sale;

  select id into v_item from sale_items where sale_id = v_sale;
  select quantity into v_before from stock_levels
  where branch_id = (select branch_a from r_ids) and variant_id = v_free;
  select count(*) into v_count from refunds;

  -- A form posts a row per sale line, most of them blank, so "every
  -- quantity is zero" is the shape a mis-submitted return actually takes.
  begin
    perform create_refund(v_sale, '00000000-0000-0000-0000-000000000001', 'cash', null,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 0, 'restock', true)));
    raise exception 'TEST FAILED: a return with every quantity at zero was accepted' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a return with nothing selected is refused (%)', sqlerrm;
  end;

  if (select count(*) from refunds) <> v_count then
    raise exception 'TEST FAILED: the refused empty return left a row behind' using errcode = 'ZZ999';
  end if;

  -- The give-away, by contrast, goes through.
  select create_refund(v_sale, '00000000-0000-0000-0000-000000000001', 'cash', null,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 2, 'restock', true))) into v_refund;

  if (select total from refunds where id = v_refund) <> 0 then
    raise exception 'TEST FAILED: a give-away refunded money (%)',
      (select total from refunds where id = v_refund) using errcode = 'ZZ999';
  end if;

  select quantity into v_after from stock_levels
  where branch_id = (select branch_a from r_ids) and variant_id = v_free;
  if v_after <> v_before + 2 then
    raise exception 'TEST FAILED: a free line did not come back onto the shelf (% -> %)', v_before, v_after
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a give-away line refunds 0.00 and still returns 2 to the shelf';

  -- And on account it writes no ledger entry at all, rather than a zero
  -- one the account ledger would reject.
  select count(*) into v_entries from customer_account_entries where reference_id = v_refund;
  if v_entries <> 0 then
    raise exception 'TEST FAILED: a 0.00 refund wrote % account entr(ies)', v_entries using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a 0.00 refund writes nothing to the account ledger';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 11. Everything reconciles ────────────────────────────────────────────

do $$
declare v_stock int; v_bal int; v_refund_mismatch int;
begin
  select count(*) into v_stock from stock_levels s
  where s.quantity is distinct from (
    select coalesce(sum(m.quantity_delta), 0) from inventory_movements m
    where m.branch_id = s.branch_id and m.variant_id = s.variant_id);

  select count(*) into v_bal from customer_balances b
  where b.balance is distinct from (
    select coalesce(sum(e.amount), 0) from customer_account_entries e
    where e.customer_id = b.customer_id);

  select count(*) into v_refund_mismatch from refunds r
  where (r.subtotal, r.tax_total, r.total) is distinct from (
    select (coalesce(sum(i.line_subtotal), 0), coalesce(sum(i.line_tax), 0), coalesce(sum(i.line_total), 0))
    from refund_items i where i.refund_id = r.id);

  if v_stock <> 0 then
    raise exception 'TEST FAILED: % stock level(s) disagree with the ledger', v_stock using errcode = 'ZZ999';
  end if;
  if v_bal <> 0 then
    raise exception 'TEST FAILED: % balance(s) disagree with the ledger', v_bal using errcode = 'ZZ999';
  end if;
  if v_refund_mismatch <> 0 then
    raise exception 'TEST FAILED: % refund(s) disagree with their own lines', v_refund_mismatch using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: stock, balances and refund totals all reconcile after voids and refunds';
end $$;

\echo ''
\echo 'All refund/void tests passed.'
