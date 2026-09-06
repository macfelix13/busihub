-- Busihub — behaviour/security test for payments (migration 0022).
--
-- The thing worth testing here is not "does a payment get recorded". It
-- is the gap in time that mobile money introduces: between the cart being
-- rung up and the money arriving, the sale is in a state it has never
-- been in before, and every other part of the system has an opinion about
-- it. So the assertions concentrate on that window — what the stock does,
-- what a void or a refund does, what happens when the money never comes,
-- and what happens when the same webhook arrives twice.
--
-- `TEST FAILED` raises carry SQLSTATE ZZ999, which no handler catches.

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select create_product(
  (select id from businesses where slug = 'busihub-demo-store'),
  'Payment Test Sugar', null, null, 'each', 'standard',
  '{}'::text[],
  '[{"sku": "PSUG-1", "barcode": "", "variant_options": {}, "cost_price": 20, "selling_price": 40}]'::jsonb
);
reset role;
reset request.jwt.claim.sub;

create table pay_ids as
select
  (select id from businesses where slug = 'busihub-demo-store') as biz_a,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'busihub-demo-store') and b.is_main) as branch_a,
  (select id from product_variants where sku = 'PSUG-1') as sugar,
  '00000000-0000-0000-0000-000000000001'::uuid as owner_a;

do $$
declare r record;
begin
  select * into r from pay_ids;
  if r.biz_a is null or r.branch_a is null or r.sugar is null then
    raise exception 'TEST FIXTURE BROKEN: pay_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

grant select on pay_ids to authenticated;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
select branch_a, sugar, 500, 'receive' from pay_ids;

-- ── 1. A cash sale is unchanged by all of this ──────────────────────────
--
-- The whole refactor is worthless if the ordinary case moved. A cash sale
-- must still complete in one step, and it must now leave a payment row
-- behind that agrees with the sale.

do $$
declare v_sale uuid; v_s record; v_pay record; v_count int;
begin
  select create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, 'cash', 200,
    jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 5))) into v_sale;

  select * into v_s from sales where id = v_sale;
  if v_s.status <> 'completed' then
    raise exception 'TEST FAILED: a cash sale did not complete (%)', v_s.status using errcode = 'ZZ999';
  end if;
  if v_s.total <> 200.00 then
    raise exception 'TEST FAILED: expected a total of 200.00, got %', v_s.total using errcode = 'ZZ999';
  end if;
  if v_s.payment_method <> 'cash' then
    raise exception 'TEST FAILED: expected payment_method cash, got %', v_s.payment_method using errcode = 'ZZ999';
  end if;

  select count(*) into v_count from sale_payments where sale_id = v_sale;
  if v_count <> 1 then
    raise exception 'TEST FAILED: expected 1 payment row, got %', v_count using errcode = 'ZZ999';
  end if;

  select * into v_pay from sale_payments where sale_id = v_sale;
  if v_pay.method <> 'cash' or v_pay.status <> 'success' or v_pay.settled_at is null then
    raise exception 'TEST FAILED: cash payment recorded as % / % / settled %',
      v_pay.method, v_pay.status, v_pay.settled_at using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a cash sale still completes in one step and records its tender';
end $$;

-- ── 2. Change is still change ───────────────────────────────────────────

do $$
declare v_sale uuid; v_s record; v_pay numeric;
begin
  select create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, 'cash', 250,
    jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 5))) into v_sale;

  select * into v_s from sales where id = v_sale;
  if v_s.change_given <> 50.00 then
    raise exception 'TEST FAILED: expected 50.00 change, got %', v_s.change_given using errcode = 'ZZ999';
  end if;

  -- The tender row holds what was handed over, not what the sale cost.
  select amount into v_pay from sale_payments where sale_id = v_sale;
  if v_pay <> 250.00 then
    raise exception 'TEST FAILED: the cash tender should be 250.00, got %', v_pay using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: cash over the total is still change, and the tender records what was handed over';
end $$;

-- ── 3. A momo sale waits — but the goods have already gone ──────────────
--
-- This is the decision the migration header argues for. If it ever
-- reverses, this assertion is the one that should fail.

do $$
declare
  v_sale uuid; v_s record; v_pay record;
  v_before numeric; v_after numeric;
begin
  select quantity into v_before from stock_levels
  where branch_id = (select branch_a from pay_ids) and variant_id = (select sugar from pay_ids);

  select create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
    jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 2)),
    jsonb_build_array(jsonb_build_object(
      'method', 'momo', 'amount', 80, 'momo_number', '0244123456', 'momo_network', 'mtn'))
  ) into v_sale;

  select * into v_s from sales where id = v_sale;
  if v_s.status <> 'awaiting_payment' then
    raise exception 'TEST FAILED: a momo sale should wait, status is %', v_s.status using errcode = 'ZZ999';
  end if;
  if v_s.payment_method <> 'momo' then
    raise exception 'TEST FAILED: expected payment_method momo, got %', v_s.payment_method using errcode = 'ZZ999';
  end if;

  select * into v_pay from sale_payments where sale_id = v_sale;
  if v_pay.status <> 'pending' or v_pay.provider <> 'paystack' then
    raise exception 'TEST FAILED: momo tender is % via %', v_pay.status, v_pay.provider using errcode = 'ZZ999';
  end if;
  -- The reference we will match the webhook on must exist at this point,
  -- or a charge.success would have nothing to find.
  if v_pay.provider_reference is distinct from v_pay.id::text then
    raise exception 'TEST FAILED: provider_reference is %, expected the payment id', v_pay.provider_reference
      using errcode = 'ZZ999';
  end if;

  select quantity into v_after from stock_levels
  where branch_id = (select branch_a from pay_ids) and variant_id = (select sugar from pay_ids);
  if v_after <> v_before - 2 then
    raise exception 'TEST FAILED: stock should leave when the cart is rung up (% -> %)', v_before, v_after
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a momo sale waits for the money, and the goods have already left the shelf';
end $$;

-- ── 4. A sale that is still waiting cannot be voided or refunded ────────
--
-- Both are corrections to a sale that was PAID for. Offering either here
-- would credit a customer who has not been charged.

do $$
declare v_sale uuid;
begin
  select id into v_sale from sales where status = 'awaiting_payment' order by created_at desc limit 1;

  begin
    perform void_sale(v_sale, null);
    raise exception 'TEST FAILED: an unpaid sale was voided' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a sale awaiting payment cannot be voided (%)', sqlerrm;
  end;

  begin
    perform create_refund(v_sale, (select owner_a from pay_ids), 'cash', null,
      jsonb_build_array(jsonb_build_object(
        'sale_item_id', (select id from sale_items where sale_id = v_sale limit 1),
        'quantity', 1, 'restock', true)));
    raise exception 'TEST FAILED: an unpaid sale was refunded' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a sale awaiting payment cannot be refunded (%)', sqlerrm;
  end;
end $$;

-- ── 5. Nobody completes a sale by writing to it ─────────────────────────

do $$
declare v_sale uuid; v_status text;
begin
  select id into v_sale from sales where status = 'awaiting_payment' order by created_at desc limit 1;

  begin
    update sales set status = 'completed' where id = v_sale;
    raise exception 'TEST FAILED: a sale was completed by writing its status' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a sale cannot be completed by writing its status (%)', sqlerrm;
  end;

  select status into v_status from sales where id = v_sale;
  if v_status <> 'awaiting_payment' then
    raise exception 'TEST FAILED: the sale moved anyway, to %', v_status using errcode = 'ZZ999';
  end if;
end $$;

-- ── 6. finalize_sale refuses a sale nobody paid for ─────────────────────
--
-- finalize_sale is granted to `authenticated` because create_sale has to
-- be able to call it. That grant is only defensible because of this: the
-- function recomputes what has been paid every time. If this assertion
-- ever fails, any cashier can complete any sale for free.

do $$
declare v_sale uuid; v_status text;
begin
  select id into v_sale from sales where status = 'awaiting_payment' order by created_at desc limit 1;

  begin
    perform finalize_sale(v_sale);
    raise exception 'TEST FAILED: finalize_sale completed an unpaid sale' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: finalize_sale refuses a sale that has not been paid for (%)', sqlerrm;
  end;

  select status into v_status from sales where id = v_sale;
  if v_status <> 'awaiting_payment' then
    raise exception 'TEST FAILED: finalize_sale moved it anyway, to %', v_status using errcode = 'ZZ999';
  end if;
end $$;

-- ── 7. A cashier cannot mark their own payment as received ──────────────

do $$
declare v_pay uuid; v_status text; v_rows int;
begin
  select p.id into v_pay from sale_payments p
  join sales s on s.id = p.sale_id
  where p.status = 'pending' order by p.created_at desc limit 1;

  -- UPDATE is revoked outright, so this raises rather than matching zero
  -- rows the way an RLS refusal would.
  begin
    update sale_payments set status = 'success' where id = v_pay;
    get diagnostics v_rows = row_count;
    raise exception 'TEST FAILED: a payment was marked received by hand (% row(s))', v_rows using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: marking a payment received by hand is refused';
  end;

  select status into v_status from sale_payments where id = v_pay;
  if v_status <> 'pending' then
    raise exception 'TEST FAILED: the payment is now %', v_status using errcode = 'ZZ999';
  end if;
end $$;

-- ── 8. Settlement is not something a browser can call ───────────────────

do $$
declare v_pay uuid;
begin
  select id into v_pay from sale_payments where status = 'pending' order by created_at desc limit 1;
  begin
    perform settle_sale_payment((select biz_a from pay_ids), v_pay, 'success', 'chg_x', null);
    raise exception 'TEST FAILED: an ordinary user settled a payment' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: settle_sale_payment is refused to an ordinary user';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 9. The money lands ──────────────────────────────────────────────────
--
-- From here on, as the server: this is the webhook's path, where there is
-- no user session at all.

set role service_role;

do $$
declare v_pay uuid; v_sale uuid; v_result text; v_s record;
begin
  select id, sale_id into v_pay, v_sale from sale_payments
  where status = 'pending' order by created_at desc limit 1;

  select settle_sale_payment((select biz_a from pay_ids), v_pay, 'success', 'chg_test_1', null) into v_result;
  if v_result <> 'completed' then
    raise exception 'TEST FAILED: settling the only tender returned %', v_result using errcode = 'ZZ999';
  end if;

  select * into v_s from sales where id = v_sale;
  if v_s.status <> 'completed' then
    raise exception 'TEST FAILED: the sale is % after its payment landed', v_s.status using errcode = 'ZZ999';
  end if;
  if (select status from sale_payments where id = v_pay) <> 'success' then
    raise exception 'TEST FAILED: the payment is not marked success' using errcode = 'ZZ999';
  end if;
  if (select provider_charge_id from sale_payments where id = v_pay) <> 'chg_test_1' then
    raise exception 'TEST FAILED: the provider charge id was not kept' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a successful momo charge completes the sale';
end $$;

-- ── 10. The same webhook arriving twice changes nothing ─────────────────
--
-- Paystack retries every 3 minutes for 4 attempts and then hourly for 72
-- hours until it gets a 200, so this is the normal case, not the edge.

do $$
declare v_pay uuid; v_sale uuid; v_result text; v_entries_before int; v_entries_after int;
begin
  select id, sale_id into v_pay, v_sale from sale_payments
  where provider_charge_id = 'chg_test_1';

  select count(*) into v_entries_before from customer_account_entries;

  select settle_sale_payment((select biz_a from pay_ids), v_pay, 'success', 'chg_test_1', null) into v_result;
  if v_result <> 'success' then
    raise exception 'TEST FAILED: a repeat settlement returned %, expected the settled status', v_result
      using errcode = 'ZZ999';
  end if;

  select count(*) into v_entries_after from customer_account_entries;
  if v_entries_after <> v_entries_before then
    raise exception 'TEST FAILED: a repeated webhook wrote % extra ledger entr(ies)',
      v_entries_after - v_entries_before using errcode = 'ZZ999';
  end if;
  if (select count(*) from sales where id = v_sale and status = 'completed') <> 1 then
    raise exception 'TEST FAILED: the sale is no longer completed after a repeat' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: the same webhook twice settles once and charges nothing twice';
end $$;

reset role;

-- ── 11. A charge that fails leaves the sale waiting ─────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_sale uuid;
begin
  select create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
    jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 1)),
    jsonb_build_array(jsonb_build_object(
      'method', 'momo', 'amount', 40, 'momo_number', '0201112223', 'momo_network', 'vod'))
  ) into v_sale;
  perform set_config('busihub.test_failed_sale', v_sale::text, false);
end $$;

reset role;
reset request.jwt.claim.sub;

set role service_role;

do $$
declare v_sale uuid; v_pay record; v_result text; v_status text;
begin
  v_sale := current_setting('busihub.test_failed_sale')::uuid;
  select * into v_pay from sale_payments where sale_id = v_sale;

  select settle_sale_payment((select biz_a from pay_ids), v_pay.id, 'failed', null, 'Insufficient funds') into v_result;
  if v_result <> 'failed' then
    raise exception 'TEST FAILED: a failed charge returned %', v_result using errcode = 'ZZ999';
  end if;

  select status into v_status from sales where id = v_sale;
  if v_status <> 'awaiting_payment' then
    raise exception 'TEST FAILED: a failed charge left the sale %', v_status using errcode = 'ZZ999';
  end if;
  if (select failure_reason from sale_payments where id = v_pay.id) <> 'Insufficient funds' then
    raise exception 'TEST FAILED: the failure reason was not kept' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a failed charge is recorded and the sale keeps waiting';
end $$;

reset role;

-- ── 12. Giving up puts the goods back ───────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_sale uuid; v_before numeric; v_after numeric; v_status text; v_reason text;
begin
  v_sale := current_setting('busihub.test_failed_sale')::uuid;

  select quantity into v_before from stock_levels
  where branch_id = (select branch_a from pay_ids) and variant_id = (select sugar from pay_ids);

  perform cancel_unpaid_sale(v_sale, 'Customer left');

  select status into v_status from sales where id = v_sale;
  if v_status <> 'cancelled' then
    raise exception 'TEST FAILED: the sale is % after cancelling', v_status using errcode = 'ZZ999';
  end if;

  select quantity into v_after from stock_levels
  where branch_id = (select branch_a from pay_ids) and variant_id = (select sugar from pay_ids);
  if v_after <> v_before + 1 then
    raise exception 'TEST FAILED: the goods did not come back (% -> %)', v_before, v_after using errcode = 'ZZ999';
  end if;

  -- Reports have to be able to tell this apart from a customer return.
  select reason into v_reason from inventory_movements
  where reference_id = v_sale and quantity_delta > 0;
  if v_reason <> 'sale_cancelled' then
    raise exception 'TEST FAILED: the reversal was recorded as %, not sale_cancelled', v_reason
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: cancelling an unpaid sale returns the goods as sale_cancelled';
end $$;

-- ── 13. A cancelled sale is finished with ───────────────────────────────

do $$
declare v_sale uuid; v_count int;
begin
  v_sale := current_setting('busihub.test_failed_sale')::uuid;

  begin
    perform cancel_unpaid_sale(v_sale, null);
    raise exception 'TEST FAILED: a cancelled sale was cancelled again' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a cancelled sale cannot be cancelled twice (%)', sqlerrm;
  end;

  -- And the stock did not come back a second time.
  select count(*) into v_count from inventory_movements
  where reference_id = v_sale and reason = 'sale_cancelled';
  if v_count <> 1 then
    raise exception 'TEST FAILED: % reversal movements for one cancellation', v_count using errcode = 'ZZ999';
  end if;
end $$;

-- ── 14. A customer who approves too late does not resurrect it ──────────

reset role;
reset request.jwt.claim.sub;
set role service_role;

do $$
declare v_sale uuid; v_pay uuid; v_result text; v_status text;
begin
  v_sale := current_setting('busihub.test_failed_sale')::uuid;
  select id into v_pay from sale_payments where sale_id = v_sale;

  select settle_sale_payment((select biz_a from pay_ids), v_pay, 'success', 'chg_late', null) into v_result;

  select status into v_status from sales where id = v_sale;
  if v_status <> 'cancelled' then
    raise exception 'TEST FAILED: a late approval revived a cancelled sale (now %)', v_status
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: approving after the sale was cancelled does not revive it (%)', v_result;
end $$;

-- ── 15. A completed sale cannot be cancelled ────────────────────────────

reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_sale uuid;
begin
  select id into v_sale from sales where status = 'completed' order by created_at desc limit 1;
  begin
    perform cancel_unpaid_sale(v_sale, null);
    raise exception 'TEST FAILED: a completed sale was cancelled' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a completed sale cannot be cancelled — that is a void (%)', sqlerrm;
  end;
end $$;

-- ── 16. Part cash, part momo ────────────────────────────────────────────

do $$
declare v_sale uuid; v_s record; v_cash record; v_momo record;
begin
  -- 5 x 40 = 200. 120 in cash, 80 on momo.
  select create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
    jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 5)),
    jsonb_build_array(
      jsonb_build_object('method', 'cash', 'amount', 120),
      jsonb_build_object('method', 'momo', 'amount', 80, 'momo_number', '0244123456', 'momo_network', 'mtn'))
  ) into v_sale;

  select * into v_s from sales where id = v_sale;
  if v_s.payment_method <> 'split' then
    raise exception 'TEST FAILED: expected payment_method split, got %', v_s.payment_method using errcode = 'ZZ999';
  end if;
  if v_s.status <> 'awaiting_payment' then
    raise exception 'TEST FAILED: a split sale with momo should wait, got %', v_s.status using errcode = 'ZZ999';
  end if;
  if v_s.change_given <> 0 then
    raise exception 'TEST FAILED: exact cash should give no change, got %', v_s.change_given using errcode = 'ZZ999';
  end if;

  select * into v_cash from sale_payments where sale_id = v_sale and method = 'cash';
  select * into v_momo from sale_payments where sale_id = v_sale and method = 'momo';
  if v_cash.status <> 'success' then
    raise exception 'TEST FAILED: the cash half is %', v_cash.status using errcode = 'ZZ999';
  end if;
  if v_momo.status <> 'pending' then
    raise exception 'TEST FAILED: the momo half is %', v_momo.status using errcode = 'ZZ999';
  end if;

  perform set_config('busihub.test_split_sale', v_sale::text, false);
  raise notice 'PASS: a split sale records both tenders and waits on the momo half';
end $$;

reset role;
reset request.jwt.claim.sub;
set role service_role;

do $$
declare v_sale uuid; v_pay uuid; v_result text; v_s record;
begin
  v_sale := current_setting('busihub.test_split_sale')::uuid;
  select id into v_pay from sale_payments where sale_id = v_sale and method = 'momo';

  select settle_sale_payment((select biz_a from pay_ids), v_pay, 'success', 'chg_split', null) into v_result;
  if v_result <> 'completed' then
    raise exception 'TEST FAILED: the split sale returned % on settlement', v_result using errcode = 'ZZ999';
  end if;

  select * into v_s from sales where id = v_sale;
  if v_s.status <> 'completed' then
    raise exception 'TEST FAILED: the split sale is % after both halves landed', v_s.status using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a split sale completes only once the momo half lands';
end $$;

reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

-- ── 17. The money has to add up ─────────────────────────────────────────

do $$
declare v_count int;
begin
  select count(*) into v_count from sales;

  -- Short.
  begin
    perform create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
      jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 5)),
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 100)));
    raise exception 'TEST FAILED: a sale was rung up short' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: tendering less than the total is refused (%)', sqlerrm;
  end;

  -- Over, on a tender that cannot give change.
  begin
    perform create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
      jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 5)),
      jsonb_build_array(jsonb_build_object(
        'method', 'momo', 'amount', 500, 'momo_number', '0244123456', 'momo_network', 'mtn')));
    raise exception 'TEST FAILED: a momo charge larger than the sale was accepted' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: charging momo for more than the sale is refused (%)', sqlerrm;
  end;

  -- The same method twice.
  begin
    perform create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
      jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 5)),
      jsonb_build_array(
        jsonb_build_object('method', 'cash', 'amount', 100),
        jsonb_build_object('method', 'cash', 'amount', 100)));
    raise exception 'TEST FAILED: the same tender was given twice' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: the same payment method twice is refused (%)', sqlerrm;
  end;

  -- Momo with no number to prompt.
  begin
    perform create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
      jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 5)),
      jsonb_build_array(jsonb_build_object('method', 'momo', 'amount', 200, 'momo_network', 'mtn')));
    raise exception 'TEST FAILED: a momo charge with no phone number was accepted' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: mobile money without a number is refused (%)', sqlerrm;
  end;

  -- An unknown network.
  begin
    perform create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
      jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 5)),
      jsonb_build_array(jsonb_build_object(
        'method', 'momo', 'amount', 200, 'momo_number', '0244123456', 'momo_network', 'glo')));
    raise exception 'TEST FAILED: an unknown momo network was accepted' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: an unknown mobile money network is refused (%)', sqlerrm;
  end;

  if (select count(*) from sales) <> v_count then
    raise exception 'TEST FAILED: a refused sale was written anyway' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: none of the refused sales left a row behind';
end $$;

-- ── 18. An account sale is all or nothing ───────────────────────────────

do $$
declare v_customer uuid;
begin
  insert into customers (business_id, name, phone, credit_limit)
  select biz_a, 'Payment Test Customer', '0277000111', 5000 from pay_ids
  returning id into v_customer;

  -- Part cash, part account.
  begin
    perform create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), v_customer, null, null,
      jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 5)),
      jsonb_build_array(
        jsonb_build_object('method', 'cash', 'amount', 100),
        jsonb_build_object('method', 'credit', 'amount', 100)));
    raise exception 'TEST FAILED: an account sale was part-paid at the till' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: an account sale cannot be part-paid at the till (%)', sqlerrm;
  end;

  -- On account for less than the sale.
  begin
    perform create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), v_customer, null, null,
      jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 5)),
      jsonb_build_array(jsonb_build_object('method', 'credit', 'amount', 150)));
    raise exception 'TEST FAILED: an account sale for less than the total was accepted' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: an account sale must be for the whole amount (%)', sqlerrm;
  end;

  perform set_config('busihub.test_customer', v_customer::text, false);
end $$;

-- ── 19. An account sale still charges the account, once ─────────────────

do $$
declare v_customer uuid; v_sale uuid; v_balance numeric; v_entries int;
begin
  v_customer := current_setting('busihub.test_customer')::uuid;

  select create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), v_customer, 'credit', 0,
    jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 3))) into v_sale;

  if (select status from sales where id = v_sale) <> 'completed' then
    raise exception 'TEST FAILED: an account sale did not complete' using errcode = 'ZZ999';
  end if;

  select balance into v_balance from customer_balances where customer_id = v_customer;
  if v_balance <> 120.00 then
    raise exception 'TEST FAILED: expected a balance of 120.00, got %', v_balance using errcode = 'ZZ999';
  end if;

  select count(*) into v_entries from customer_account_entries where reference_id = v_sale;
  if v_entries <> 1 then
    raise exception 'TEST FAILED: % account entries for one sale', v_entries using errcode = 'ZZ999';
  end if;

  -- And the tender row is the whole total, not the zero the old
  -- two-argument form passes as amount_tendered.
  if (select amount from sale_payments where sale_id = v_sale) <> 120.00 then
    raise exception 'TEST FAILED: the credit tender is %, expected 120.00',
      (select amount from sale_payments where sale_id = v_sale) using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: an account sale charges the account once and records a tender for the whole total';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 20. The Paystack secret is not readable, by anyone ordinary ─────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_text text;
begin
  insert into business_payment_settings (
    business_id, paystack_public_key, paystack_secret_cipher, paystack_secret_last4,
    is_live, momo_enabled, configured_at
  )
  select biz_a, 'pk_test_public', 'ENCRYPTED-CIPHERTEXT', 'ab12', false, true, now() from pay_ids;

  -- The owner may see everything they need to recognise the key...
  select paystack_public_key into v_text from business_payment_settings;
  if v_text <> 'pk_test_public' then
    raise exception 'TEST FAILED: the owner cannot read their own public key' using errcode = 'ZZ999';
  end if;

  -- ...and not the key itself. This is the 0018 lesson: the revoke has to
  -- come before the grant, or the column stays readable.
  begin
    select paystack_secret_cipher into v_text from business_payment_settings;
    raise exception 'TEST FAILED: the Paystack secret key ciphertext is readable (%)', v_text
      using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: the Paystack secret ciphertext cannot be read, even by the owner';
  end;

  begin
    perform * from paystack_events;
    raise exception 'TEST FAILED: webhook events are readable by an ordinary user' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: the webhook event log is server-only';
  end;
end $$;

-- ── 21. A cashier cannot connect a Paystack account ─────────────────────

reset role;
reset request.jwt.claim.sub;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000095';

do $$
declare v_count int;
begin
  -- The till-only Cashier from the refunds fixture: sales.process, and
  -- nothing that manages the business.
  if exists (select 1 from profiles where id = '00000000-0000-0000-0000-000000000095') then
    select count(*) into v_count from business_payment_settings;
    if v_count <> 0 then
      raise exception 'TEST FAILED: a cashier can read the payment settings (% row(s))', v_count
        using errcode = 'ZZ999';
    end if;
    raise notice 'PASS: a cashier cannot see the shop''s payment settings at all';

    begin
      update business_payment_settings set paystack_public_key = 'pk_live_attacker';
      get diagnostics v_count = row_count;
      if v_count <> 0 then
        raise exception 'TEST FAILED: a cashier changed the Paystack key' using errcode = 'ZZ999';
      end if;
      raise notice 'PASS: a cashier changing the Paystack key matches no rows';
    exception when insufficient_privilege then
      raise notice 'PASS: a cashier changing the Paystack key is refused outright';
    end;
  else
    raise exception 'TEST FIXTURE BROKEN: the cashier from refunds.sql is missing' using errcode = 'ZZ999';
  end if;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 21b. The till never names the amount to charge ──────────────────────
--
-- A momo tender with no amount means "whatever the cash did not cover".
-- This is how the till actually rings up mobile money: it does not know
-- the authoritative total, so if it had to state the figure it could be
-- wrong — or be made to prompt a customer's phone for an amount of its
-- own choosing. (Migration 0024.)

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_sale uuid; v_s record; v_momo record; v_cash record; v_count int;
begin
  -- 5 x 40 = 200, with 60 in cash. The momo half must come out at 140
  -- without anyone saying so.
  select create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
    jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 5)),
    jsonb_build_array(
      jsonb_build_object('method', 'cash', 'amount', 60),
      jsonb_build_object('method', 'momo', 'momo_number', '0244123456', 'momo_network', 'mtn'))
  ) into v_sale;

  select * into v_s from sales where id = v_sale;
  select * into v_momo from sale_payments where sale_id = v_sale and method = 'momo';
  select * into v_cash from sale_payments where sale_id = v_sale and method = 'cash';

  if v_momo.amount <> 140.00 then
    raise exception 'TEST FAILED: the momo half should be 140.00, got %', v_momo.amount using errcode = 'ZZ999';
  end if;
  if v_cash.amount <> 60.00 then
    raise exception 'TEST FAILED: the cash half should be 60.00, got %', v_cash.amount using errcode = 'ZZ999';
  end if;
  if v_s.change_given <> 0 then
    raise exception 'TEST FAILED: a split that adds up exactly gives no change, got %', v_s.change_given
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: an unpriced momo tender is charged exactly what the cash left over';

  -- Mobile money alone, no cash: the whole total.
  select create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
    jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 2)),
    jsonb_build_array(jsonb_build_object('method', 'momo', 'momo_number', '0244123456', 'momo_network', 'mtn'))
  ) into v_sale;

  if (select amount from sale_payments where sale_id = v_sale) <> 80.00 then
    raise exception 'TEST FAILED: a momo-only sale should charge the whole 80.00' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a mobile money sale with no cash charges the whole total';

  -- And cash that already covers the sale leaves nothing to charge, which
  -- is a mistake at the counter rather than a zero-value prompt.
  select count(*) into v_count from sales;
  begin
    perform create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
      jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 1)),
      jsonb_build_array(
        jsonb_build_object('method', 'cash', 'amount', 100),
        jsonb_build_object('method', 'momo', 'momo_number', '0244123456', 'momo_network', 'mtn')));
    raise exception 'TEST FAILED: a momo prompt was raised for nothing' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: cash covering the whole sale leaves no momo charge to make (%)', sqlerrm;
  end;
  if (select count(*) from sales) <> v_count then
    raise exception 'TEST FAILED: the refused split left a sale behind' using errcode = 'ZZ999';
  end if;

  -- An unpriced momo tender still needs a phone to prompt.
  begin
    perform create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
      jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 1)),
      jsonb_build_array(jsonb_build_object('method', 'momo', 'momo_network', 'mtn')));
    raise exception 'TEST FAILED: an unpriced momo tender skipped the phone number check' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: an unpriced momo tender still needs a number and a network (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 21c. An explicit JSON null means the same as leaving it out ─────────
--
-- This is the assertion that would have caught the bug 0025 fixes, and
-- did not exist because every test above builds its payload with
-- jsonb_build_object and simply omits the key. The application does not:
-- JSON.stringify writes `"amount": null`, and in PostgreSQL that is NOT
-- SQL NULL. Every mobile money sale was refused in the browser while the
-- whole suite stayed green.
--
-- So these cases send exactly what the till sends.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_sale uuid; v_momo record; v_cash record; v_customer uuid;
begin
  -- 3 x 40 = 120, with 20 in cash, and the momo amount sent as an
  -- explicit null exactly as JSON.stringify writes it.
  select create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
    jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 3)),
    jsonb_build_array(
      jsonb_build_object('method', 'cash', 'amount', 20),
      jsonb_build_object('method', 'momo', 'amount', null,
                         'momo_number', '0244123456', 'momo_network', 'mtn'))
  ) into v_sale;

  select * into v_momo from sale_payments where sale_id = v_sale and method = 'momo';
  select * into v_cash from sale_payments where sale_id = v_sale and method = 'cash';

  if v_momo.amount <> 100.00 then
    raise exception 'TEST FAILED: an explicit null amount gave %, expected 100.00', v_momo.amount
      using errcode = 'ZZ999';
  end if;
  if v_cash.amount <> 20.00 then
    raise exception 'TEST FAILED: the cash half is %, expected 20.00', v_cash.amount using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a momo tender with an explicit JSON null amount is charged the remainder';

  -- And the same for an account sale, which has the identical branch.
  insert into customers (business_id, name, phone, credit_limit)
  select biz_a, 'Json Null Customer', '0277000222', 5000 from pay_ids
  returning id into v_customer;

  select create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), v_customer, null, null,
    jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 2)),
    jsonb_build_array(jsonb_build_object('method', 'credit', 'amount', null))
  ) into v_sale;

  if (select amount from sale_payments where sale_id = v_sale) <> 80.00 then
    raise exception 'TEST FAILED: an explicit null on an account sale gave %',
      (select amount from sale_payments where sale_id = v_sale) using errcode = 'ZZ999';
  end if;
  if (select status from sales where id = v_sale) <> 'completed' then
    raise exception 'TEST FAILED: the account sale did not complete' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a credit tender with an explicit JSON null amount is the whole total';

  -- A stated zero is still a mistake, not "work it out for me".
  begin
    perform create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
      jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 1)),
      jsonb_build_array(jsonb_build_object('method', 'momo', 'amount', 0,
                                           'momo_number', '0244123456', 'momo_network', 'mtn')));
    raise exception 'TEST FAILED: a stated zero was treated as "work it out"' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: an amount of zero is still refused (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 22. One shop's webhook cannot settle another shop's payment ─────────
--
-- The webhook endpoint is per business and its signature is checked with
-- that shop's own Paystack secret. A shop therefore CAN produce a validly
-- signed charge.success for any reference it likes — including a
-- reference belonging to someone else's sale. Proving you are business A
-- says nothing about a payment owned by business B, and this is where
-- that gap is closed. (Migration 0023; 0022 checked only the payment id.)

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_sale uuid;
begin
  select create_sale((select branch_a from pay_ids), (select owner_a from pay_ids), null, null, null,
    jsonb_build_array(jsonb_build_object('variant_id', (select sugar from pay_ids), 'quantity', 1)),
    jsonb_build_array(jsonb_build_object(
      'method', 'momo', 'amount', 40, 'momo_number', '0244999888', 'momo_network', 'mtn'))
  ) into v_sale;
  perform set_config('busihub.test_victim_sale', v_sale::text, false);
end $$;

reset role;
reset request.jwt.claim.sub;
set role service_role;

do $$
declare v_sale uuid; v_pay uuid; v_other uuid; v_status text;
begin
  v_sale := current_setting('busihub.test_victim_sale')::uuid;
  select id into v_pay from sale_payments where sale_id = v_sale;

  select id into v_other from businesses where id <> (select biz_a from pay_ids) limit 1;
  if v_other is null then
    raise exception 'TEST FIXTURE BROKEN: the seed has only one business' using errcode = 'ZZ999';
  end if;

  begin
    perform settle_sale_payment(v_other, v_pay, 'success', 'chg_attacker', null);
    raise exception 'TEST FAILED: another business settled this payment' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a signed webhook from another business cannot settle this payment';
  end;

  -- And a null business id is not a wildcard.
  begin
    perform settle_sale_payment(null, v_pay, 'success', 'chg_null', null);
    raise exception 'TEST FAILED: a null business id settled a payment' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a missing business id is refused rather than treated as any business';
  end;

  select status into v_status from sale_payments where id = v_pay;
  if v_status <> 'pending' then
    raise exception 'TEST FAILED: the payment is now %', v_status using errcode = 'ZZ999';
  end if;
  if (select status from sales where id = v_sale) <> 'awaiting_payment' then
    raise exception 'TEST FAILED: the victim sale moved' using errcode = 'ZZ999';
  end if;
end $$;

reset role;

-- ── 23. History has tenders too ─────────────────────────────────────────
--
-- Every sale in the seed predates the ledger. 0023 backfills them, and
-- the reconciliation below would not hold without it.

do $$
declare v_missing int;
begin
  select count(*) into v_missing
  from sales s
  where s.status in ('completed', 'voided')
    and s.total > 0
    and not exists (select 1 from sale_payments p where p.sale_id = s.id);

  if v_missing > 0 then
    raise exception 'TEST FAILED: % settled sale(s) have no tender at all', v_missing using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: every completed or voided sale has at least one tender, history included';
end $$;

-- ── 24. Everything reconciles ───────────────────────────────────────────

do $$
declare v_stock int; v_bal int; v_unpaid int; v_orphan int;
begin
  select count(*) into v_stock from stock_levels s
  where s.quantity is distinct from (
    select coalesce(sum(m.quantity_delta), 0) from inventory_movements m
    where m.branch_id = s.branch_id and m.variant_id = s.variant_id);

  select count(*) into v_bal from customer_balances b
  where b.balance is distinct from (
    select coalesce(sum(e.amount), 0) from customer_account_entries e
    where e.customer_id = b.customer_id);

  -- Every completed sale is covered by its own successful tenders.
  select count(*) into v_unpaid from sales s
  where s.status = 'completed'
    and s.total > (
      select coalesce(sum(p.amount), 0) - s.change_given from sale_payments p
      where p.sale_id = s.id and p.status = 'success');

  -- And nothing was charged to a sale that never completed.
  select count(*) into v_orphan from customer_account_entries e
  join sales s on s.id = e.reference_id
  where e.reference_type = 'sale' and s.status not in ('completed', 'voided');

  if v_stock <> 0 then
    raise exception 'TEST FAILED: % stock level(s) disagree with the ledger', v_stock using errcode = 'ZZ999';
  end if;
  if v_bal <> 0 then
    raise exception 'TEST FAILED: % balance(s) disagree with the ledger', v_bal using errcode = 'ZZ999';
  end if;
  if v_unpaid <> 0 then
    raise exception 'TEST FAILED: % completed sale(s) are not covered by their payments', v_unpaid
      using errcode = 'ZZ999';
  end if;
  if v_orphan <> 0 then
    raise exception 'TEST FAILED: % account entr(ies) belong to a sale that never completed', v_orphan
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: stock, balances and every completed sale''s payments all reconcile';
end $$;

\echo ''
\echo 'All payment tests passed.'