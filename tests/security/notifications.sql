-- Busihub — behaviour/security tests for notifications (0034, Phase 15).
--
-- Two different kinds of alert are being tested here, and they are tested
-- differently on purpose (see 0034's header for why): low_stock,
-- credit_limit and stuck_payment are STATE, so the test proves they
-- appear while true and are absent otherwise — never that a row was
-- written. refund_created and sale_voided are EVENTS, so the test proves
-- a specific row was written once, with the right data, attributed to the
-- right person.
--
-- Everything is measured against two businesses this file creates itself
-- — no assertion here depends on which suites ran before it.
--
-- `TEST FAILED` raises carry SQLSTATE ZZ999, which no handler catches.

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000201',
   'authenticated', 'authenticated', 'notifowner1@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000202',
   'authenticated', 'authenticated', 'notifowner2@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000201';
select register_business('Notif Test Shop N', 'Akosua', 'Boateng');

set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000202';
select register_business('Notif Test Shop N2', 'Yaw', 'Asante');

reset role;
reset request.jwt.claim.sub;

create table n_ids as
select
  (select id from businesses where slug = 'notif-test-shop-n')                                        as biz_n,
  (select id from businesses where slug = 'notif-test-shop-n2')                                       as biz_n2,
  (select b.id from branches b where b.business_id = (select id from businesses where slug = 'notif-test-shop-n') and b.is_main) as branch_n;

do $$
declare r record;
begin
  select * into r from n_ids;
  if r.biz_n is null or r.biz_n2 is null or r.branch_n is null then
    raise exception 'TEST FIXTURE BROKEN: n_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

grant select on n_ids to authenticated;

-- A Cashier in business N: inventory.view + customers.view + sales.process,
-- but NOT reports.view, sales.void or sales.refund — exactly the split
-- section 8 below depends on.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000203',
   'authenticated', 'authenticated', 'notifcashier@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

do $$
declare v_role uuid;
begin
  select id into v_role from roles where business_id = (select biz_n from n_ids) and name = 'Cashier';
  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000203', (select biz_n from n_ids), 'Front', 'Counter', 'notifcashier@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);
  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values ((select biz_n from n_ids), (select branch_n from n_ids), '00000000-0000-0000-0000-000000000203', v_role,
            '00000000-0000-0000-0000-000000000201')
    on conflict do nothing;
end $$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000201';

-- Rice: opening stock 3, under the default threshold of 5 (low, not out).
select create_product(
  (select biz_n from n_ids), 'Notif Rice', null, 'Food', 'bag', 'zero_rated',
  '{}'::text[],
  '[{"sku": "NOTIF-RICE", "barcode": "", "variant_options": {}, "cost_price": 20, "selling_price": 35, "opening_stock": 3}]'::jsonb,
  (select branch_n from n_ids)
);
-- Salt: opening stock 1, then adjusted down to 0. low_stock_report()
-- deliberately excludes anything NEVER stocked at all (a product created
-- with opening_stock 0 has no stock_levels row and is invisible to it, by
-- design — see its own header), so "out of stock" has to be reached by
-- selling or adjusting a real stock level down to zero, not by starting
-- there.
select create_product(
  (select biz_n from n_ids), 'Notif Salt', null, 'Food', 'bag', 'zero_rated',
  '{}'::text[],
  '[{"sku": "NOTIF-SALT", "barcode": "", "variant_options": {}, "cost_price": 5, "selling_price": 8, "opening_stock": 1}]'::jsonb,
  (select branch_n from n_ids)
);
-- A third product with healthy stock — the negative control: it must
-- never appear in the feed at all.
select create_product(
  (select biz_n from n_ids), 'Notif Sugar', null, 'Food', 'bag', 'zero_rated',
  '{}'::text[],
  '[{"sku": "NOTIF-SUGAR", "barcode": "", "variant_options": {}, "cost_price": 8, "selling_price": 15, "opening_stock": 50}]'::jsonb,
  (select branch_n from n_ids)
);

reset role;
reset request.jwt.claim.sub;

create table n_variants as
select
  (select id from product_variants where sku = 'NOTIF-RICE')  as rice,
  (select id from product_variants where sku = 'NOTIF-SALT')  as salt,
  (select id from product_variants where sku = 'NOTIF-SUGAR') as sugar;
grant select on n_variants to authenticated;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000201';

-- Sell the one bag of salt, taking it from 1 to genuinely, ledger-backed 0.
insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
select branch_n, salt, -1, 'adjustment' from n_ids, n_variants;

-- Two customers: one taken to EXACTLY her limit (alerts), one left well
-- under hers (does not).
insert into customers (business_id, name, phone, credit_limit)
values
  ((select biz_n from n_ids), 'Maxed Customer', '0244000001', 100),
  ((select biz_n from n_ids), 'Under Customer', '0244000002', 500);

reset role;
reset request.jwt.claim.sub;

create table n_customers as
select
  (select id from customers where name = 'Maxed Customer')  as maxed,
  (select id from customers where name = 'Under Customer')  as under_limit;
grant select on n_customers to authenticated;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000201';

insert into customer_account_entries (business_id, customer_id, amount, entry_type, note)
values
  ('00000000-0000-0000-0000-000000000000', (select maxed from n_customers), 100, 'charge', 'Reaches the limit exactly'),
  ('00000000-0000-0000-0000-000000000000', (select under_limit from n_customers), 50, 'charge', 'Well under her 500 limit');

-- A momo sale left stuck (backdated below) and a fresh one (left alone,
-- to prove the 15-minute floor is a floor and not a rubber stamp).
select create_sale(
  (select branch_n from n_ids), '00000000-0000-0000-0000-000000000201', null, 'momo', 0,
  jsonb_build_array(jsonb_build_object('variant_id', (select sugar from n_variants), 'quantity', 1)),
  jsonb_build_array(jsonb_build_object('method', 'momo', 'amount', 15, 'momo_number', '0244123456', 'momo_network', 'mtn'))
);
select create_sale(
  (select branch_n from n_ids), '00000000-0000-0000-0000-000000000201', null, 'momo', 0,
  jsonb_build_array(jsonb_build_object('variant_id', (select sugar from n_variants), 'quantity', 1)),
  jsonb_build_array(jsonb_build_object('method', 'momo', 'amount', 15, 'momo_number', '0244123456', 'momo_network', 'mtn'))
);

-- A sale that will be voided, and one that will be partially refunded.
select create_sale(
  (select branch_n from n_ids), '00000000-0000-0000-0000-000000000201', null, 'cash', 15,
  jsonb_build_array(jsonb_build_object('variant_id', (select sugar from n_variants), 'quantity', 1))
);
select create_sale(
  (select branch_n from n_ids), '00000000-0000-0000-0000-000000000201', null, 'cash', 15,
  jsonb_build_array(jsonb_build_object('variant_id', (select sugar from n_variants), 'quantity', 1))
);

reset role;
reset request.jwt.claim.sub;

-- Backdate one momo sale past the 15-minute floor, and stamp receipt
-- numbers so later sections can refer to sales by name rather than by
-- "the most recent one".
create table n_sales as
select
  a.id as stuck_sale, a.receipt_number as stuck_receipt,
  b.id as fresh_sale,
  c.id as void_sale_id, c.receipt_number as void_receipt,
  d.id as refund_sale_id, d.receipt_number as refund_receipt
from
  (select id, receipt_number from sales where business_id = (select biz_n from n_ids) and payment_method = 'momo' order by created_at asc limit 1) a,
  (select id from sales where business_id = (select biz_n from n_ids) and payment_method = 'momo' order by created_at desc limit 1) b,
  (select id, receipt_number from sales where business_id = (select biz_n from n_ids) and payment_method = 'cash' order by created_at asc limit 1) c,
  (select id, receipt_number from sales where business_id = (select biz_n from n_ids) and payment_method = 'cash' order by created_at desc limit 1) d;
grant select on n_sales to authenticated;

update sales set created_at = now() - interval '20 minutes' where id = (select stuck_sale from n_sales);

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000201';
select void_sale((select void_sale_id from n_sales), 'Customer changed their mind');
select create_refund(
  (select refund_sale_id from n_sales), '00000000-0000-0000-0000-000000000201', 'cash', 'Wrong item',
  jsonb_build_array(jsonb_build_object(
    'sale_item_id', (select id from sale_items where sale_id = (select refund_sale_id from n_sales)),
    'quantity', 1, 'restock', true
  ))
);
reset role;
reset request.jwt.claim.sub;

-- ── 1. Low stock: appears while true, healthy stock never appears ───────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000201';

do $$
declare v_rice_key text; v_salt_key text; v_sugar_count int; v_rice_sev text; v_salt_sev text;
begin
  select 'low_stock:' || (select rice from n_variants) || ':' || (select branch_n from n_ids) into v_rice_key;
  select 'low_stock:' || (select salt from n_variants) || ':' || (select branch_n from n_ids) into v_salt_key;

  select severity into v_rice_sev from notification_feed(null, 200) where dismissal_key = v_rice_key;
  select severity into v_salt_sev from notification_feed(null, 200) where dismissal_key = v_salt_key;

  if v_rice_sev is null then
    raise exception 'TEST FAILED: Notif Rice (3 on hand, threshold 5) did not appear as low_stock' using errcode = 'ZZ999';
  end if;
  if v_rice_sev <> 'warning' then
    raise exception 'TEST FAILED: Notif Rice should map to warning severity ("low"), got %', v_rice_sev using errcode = 'ZZ999';
  end if;
  if v_salt_sev is distinct from 'critical' then
    raise exception 'TEST FAILED: Notif Salt (0 on hand — out) should map to critical severity, got %', v_salt_sev using errcode = 'ZZ999';
  end if;

  select count(*) into v_sugar_count from notification_feed(null, 200)
  where dismissal_key = 'low_stock:' || (select sugar from n_variants) || ':' || (select branch_n from n_ids);
  if v_sugar_count <> 0 then
    raise exception 'TEST FAILED: Notif Sugar has 50 on hand and should never appear as low stock' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: low stock alerts appear with the right severity, healthy stock does not appear at all';
end $$;

-- ── 2. Low stock respects business_settings.notification_settings ───────

do $$
declare v_count int; v_key text;
begin
  v_key := 'low_stock:' || (select rice from n_variants) || ':' || (select branch_n from n_ids);

  update business_settings
    set notification_settings = jsonb_set(notification_settings, '{low_stock_alerts}', 'false')
    where business_id = (select biz_n from n_ids);

  select count(*) into v_count from notification_feed(null, 200) where dismissal_key = v_key;
  if v_count <> 0 then
    raise exception 'TEST FAILED: low_stock_alerts=false should suppress the alert entirely, still saw %', v_count
      using errcode = 'ZZ999';
  end if;

  update business_settings
    set notification_settings = jsonb_set(notification_settings, '{low_stock_alerts}', 'true')
    where business_id = (select biz_n from n_ids);

  select count(*) into v_count from notification_feed(null, 200) where dismissal_key = v_key;
  if v_count <> 1 then
    raise exception 'TEST FAILED: turning low_stock_alerts back on should restore the alert, got count %', v_count
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: the notification_settings.low_stock_alerts toggle is honoured both ways';
end $$;

-- ── 3. Credit limit: exactly at the limit alerts, well under does not ───

do $$
declare v_maxed_count int; v_under_count int;
begin
  select count(*) into v_maxed_count from notification_feed(null, 200)
  where dismissal_key = 'credit_limit:' || (select maxed from n_customers);
  select count(*) into v_under_count from notification_feed(null, 200)
  where dismissal_key = 'credit_limit:' || (select under_limit from n_customers);

  if v_maxed_count <> 1 then
    raise exception 'TEST FAILED: a customer sitting exactly at her credit limit should alert, count %', v_maxed_count
      using errcode = 'ZZ999';
  end if;
  if v_under_count <> 0 then
    raise exception 'TEST FAILED: a customer at 50 of a 500 limit should not alert, count %', v_under_count
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: credit-limit alerts fire at the limit, not before it';
end $$;

-- ── 4. Stuck payment: the 15-minute floor is a floor ─────────────────────

do $$
declare v_stuck_count int; v_fresh_count int;
begin
  select count(*) into v_stuck_count from notification_feed(null, 200)
  where dismissal_key = 'stuck_payment:' || (select stuck_sale from n_sales);
  select count(*) into v_fresh_count from notification_feed(null, 200)
  where dismissal_key = 'stuck_payment:' || (select fresh_sale from n_sales);

  if v_stuck_count <> 1 then
    raise exception 'TEST FAILED: a momo sale rung up 20 minutes ago and still unpaid should alert, count %', v_stuck_count
      using errcode = 'ZZ999';
  end if;
  if v_fresh_count <> 0 then
    raise exception 'TEST FAILED: a momo sale rung up moments ago should not alert yet, count %', v_fresh_count
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: stuck-payment alerts respect the 15-minute floor';
end $$;

-- ── 5. sale_voided: a real event, with the right data ────────────────────

do $$
declare v_data jsonb; v_severity text;
begin
  select data, severity into v_data, v_severity from notification_feed(null, 200)
  where type = 'sale_voided' and reference_id = (select void_sale_id from n_sales);

  if v_data is null then
    raise exception 'TEST FAILED: voiding a sale did not produce a sale_voided notification' using errcode = 'ZZ999';
  end if;
  if v_data ->> 'receipt_number' <> (select void_receipt from n_sales) then
    raise exception 'TEST FAILED: sale_voided data has the wrong receipt number: %', v_data using errcode = 'ZZ999';
  end if;
  if v_data ->> 'reason' <> 'Customer changed their mind' then
    raise exception 'TEST FAILED: sale_voided data lost the reason: %', v_data using errcode = 'ZZ999';
  end if;
  if (v_data ->> 'total')::numeric <> 15.00 then
    raise exception 'TEST FAILED: sale_voided data has the wrong total: %', v_data using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: void_sale() records a sale_voided notification with receipt, reason and total intact';
end $$;

-- ── 6. refund_created: a real event, with the right data ─────────────────

do $$
declare v_data jsonb;
begin
  select data into v_data from notification_feed(null, 200)
  where type = 'refund_created' and reference_id = (select refund_sale_id from n_sales);

  if v_data is null then
    raise exception 'TEST FAILED: creating a refund did not produce a refund_created notification' using errcode = 'ZZ999';
  end if;
  if v_data ->> 'receipt_number' <> (select refund_receipt from n_sales) then
    raise exception 'TEST FAILED: refund_created data has the wrong receipt number: %', v_data using errcode = 'ZZ999';
  end if;
  if v_data ->> 'refund_number' !~ '^RF-[0-9]+$' then
    raise exception 'TEST FAILED: refund_created data has no refund number: %', v_data using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: create_refund() records a refund_created notification with the refund it made';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 7. Cross-tenant isolation ─────────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000202';

do $$
declare v_count int;
begin
  select count(*) into v_count from notification_feed(null, 200)
  where dismissal_key in (
    'low_stock:' || (select rice from n_variants) || ':' || (select branch_n from n_ids),
    'credit_limit:' || (select maxed from n_customers),
    'stuck_payment:' || (select stuck_sale from n_sales),
    'event:' || (select id::text from notifications where reference_id = (select void_sale_id from n_sales))
  );
  if v_count <> 0 then
    raise exception 'TEST FAILED: business N2''s owner should see none of business N''s notifications, saw %', v_count
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a second, unrelated business sees none of these notifications';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 8. Visibility follows existing permissions, not a new one ───────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000203'; -- the Cashier

do $$
declare v_low int; v_credit int; v_stuck int; v_void int; v_refund int;
begin
  select count(*) into v_low from notification_feed(null, 200)
    where dismissal_key = 'low_stock:' || (select rice from n_variants) || ':' || (select branch_n from n_ids);
  select count(*) into v_credit from notification_feed(null, 200)
    where dismissal_key = 'credit_limit:' || (select maxed from n_customers);
  select count(*) into v_stuck from notification_feed(null, 200)
    where dismissal_key = 'stuck_payment:' || (select stuck_sale from n_sales);
  select count(*) into v_void from notification_feed(null, 200)
    where type = 'sale_voided' and reference_id = (select void_sale_id from n_sales);
  select count(*) into v_refund from notification_feed(null, 200)
    where type = 'refund_created' and reference_id = (select refund_sale_id from n_sales);

  if v_low <> 1 or v_credit <> 1 or v_stuck <> 1 then
    raise exception 'TEST FAILED: a Cashier holds inventory.view/customers.view/sales.process and should see low_stock (%), credit_limit (%), stuck_payment (%)',
      v_low, v_credit, v_stuck using errcode = 'ZZ999';
  end if;
  if v_void <> 0 or v_refund <> 0 then
    raise exception 'TEST FAILED: a Cashier holds neither reports.view nor sales.void/sales.refund and should see NEITHER event type (void %, refund %)',
      v_void, v_refund using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a Cashier sees the state alerts their permissions already admit, and none of the event log';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 9. The INSERT policy is the real gate, not the two call sites ───────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000203'; -- the Cashier again

do $$
begin
  begin
    insert into notifications (business_id, branch_id, type, severity, reference_type, reference_id, actor_user_id, data)
    values (
      (select biz_n from n_ids), (select branch_n from n_ids), 'sale_voided', 'critical', 'sale',
      (select refund_sale_id from n_sales), '00000000-0000-0000-0000-000000000203', '{}'::jsonb
    );
    raise exception 'TEST FAILED: a Cashier without sales.void inserted a fake sale_voided notification directly' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a Cashier cannot fabricate a sale_voided notification via a direct insert';
  end;
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000201'; -- the Owner, who DOES hold sales.void

do $$
begin
  begin
    -- Framing a colleague: actor_user_id set to someone else even though
    -- the Owner is the one actually signed in and running this insert.
    insert into notifications (business_id, branch_id, type, severity, reference_type, reference_id, actor_user_id, data)
    values (
      (select biz_n from n_ids), (select branch_n from n_ids), 'sale_voided', 'critical', 'sale',
      (select refund_sale_id from n_sales), '00000000-0000-0000-0000-000000000203', '{}'::jsonb
    );
    raise exception 'TEST FAILED: the Owner attributed a notification to someone else and it was accepted' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: actor_user_id must be the caller themselves — nobody can attribute an event to a colleague';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 10. Read state is per-user ────────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000201'; -- Owner

do $$
declare v_key text; v_owner_read boolean;
begin
  v_key := 'low_stock:' || (select rice from n_variants) || ':' || (select branch_n from n_ids);
  perform mark_notification_read(v_key);

  select is_read into v_owner_read from notification_feed(null, 200) where dismissal_key = v_key;
  if v_owner_read is distinct from true then
    raise exception 'TEST FAILED: mark_notification_read() did not mark it read for the caller' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: mark_notification_read() marks it read for the caller';
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000203'; -- Cashier, different person

do $$
declare v_key text; v_cashier_read boolean;
begin
  v_key := 'low_stock:' || (select rice from n_variants) || ':' || (select branch_n from n_ids);
  select is_read into v_cashier_read from notification_feed(null, 200) where dismissal_key = v_key;
  if v_cashier_read is distinct from false then
    raise exception 'TEST FAILED: the Owner marking something read leaked into the Cashier''s own read state' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: read state does not leak between users sharing the same business';
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000201'; -- back to Owner

do $$
declare v_unread int;
begin
  perform mark_all_notifications_read();
  select count(*) into v_unread from notification_feed(null, 200) where not is_read;
  if v_unread <> 0 then
    raise exception 'TEST FAILED: mark_all_notifications_read() left % unread for the caller', v_unread using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: mark_all_notifications_read() clears everything the caller can see';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 11. Nothing in this migration is SECURITY DEFINER ────────────────────
--
-- notification_feed_base()/notification_feed() grant no visibility of
-- their own — every row already passed the underlying table's RLS. The
-- one word that would turn that into a leak is SECURITY DEFINER, checked
-- directly from the catalog the same way the reporting functions are
-- (0030).

do $$
declare v_definer text;
begin
  select string_agg(p.proname, ', ')
  into v_definer
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in (
      'notification_feed_base', 'notification_feed',
      'mark_notification_read', 'mark_notification_unread', 'mark_all_notifications_read',
      'void_sale', 'create_refund'
    )
    and p.prosecdef;

  if v_definer is not null then
    raise exception 'TEST FAILED: these should run as the caller, not SECURITY DEFINER: %', v_definer
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: every notification function runs as the caller — RLS is the real gate';
end $$;

drop table n_ids, n_variants, n_customers, n_sales;