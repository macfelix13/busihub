-- Busihub — security/behaviour test for customers & credit accounts
-- (migration 0017), exercised directly against Postgres + RLS rather than
-- through the application.
--
-- Run against a throwaway Postgres loaded with
-- tests/db-harness/00_stub_supabase.sql + supabase/migrations/*.sql +
-- supabase/seed.sql (see tests/security/README.md).
--
-- Every `TEST FAILED` raise carries SQLSTATE ZZ999, which no handler in
-- this file catches. That matters: the default for `raise exception` is
-- P0001, which several blocks below catch as the *expected* rejection —
-- so a wrongly-succeeding operation would otherwise have its own failure
-- message swallowed and printed as a PASS.

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000044',
   'authenticated', 'authenticated', 'ownerd@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000097',
   'authenticated', 'authenticated', 'auditor@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000044';
select register_business('Customer Test Shop D', 'Esi', 'Mensah');
reset role;
reset request.jwt.claim.sub;

create table c_ids as
select
  (select id from businesses where slug = 'busihub-demo-store')      as biz_a,
  (select id from businesses where slug = 'customer-test-shop-d')    as biz_d,
  (select b.id from branches b
     where b.business_id = (select id from businesses where slug = 'busihub-demo-store')
       and b.is_main)                                                as branch_a,
  (select b.id from branches b
     where b.business_id = (select id from businesses where slug = 'customer-test-shop-d')
       and b.is_main)                                                as branch_d;

do $$
declare r record;
begin
  select * into r from c_ids;
  if r.biz_a is null or r.biz_d is null or r.branch_a is null or r.branch_d is null then
    raise exception 'TEST FIXTURE BROKEN: c_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

grant select on c_ids to authenticated;

-- An Auditor on business A: customers.view but NOT customers.edit.
do $$
declare v_biz uuid; v_branch uuid; v_role uuid;
begin
  select biz_a, branch_a into v_biz, v_branch from c_ids;
  select id into v_role from roles where business_id = v_biz and name = 'Auditor';

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000097', v_biz, 'Read', 'Only', 'auditor@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000000097', v_role,
            '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;

  -- Guard the fixture: if Auditor ever gains customers.edit, test 9 would
  -- "pass" for entirely the wrong reason.
  if exists (
    select 1 from role_permissions rp join permissions p on p.id = rp.permission_id
    where rp.role_id = v_role and p.key = 'customers.edit'
  ) then
    raise exception 'TEST FIXTURE BROKEN: Auditor unexpectedly holds customers.edit' using errcode = 'ZZ999';
  end if;
end $$;

-- ── 1. Phone uniqueness survives reformatting ────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_a uuid; v_key text;
begin
  insert into customers (business_id, name, phone, credit_limit)
  select biz_a, 'Ama Owusu', '024 412 3456', 500 from c_ids returning id into v_a;

  select phone_key into v_key from customers where id = v_a;
  if v_key <> '0244123456' then
    raise exception 'TEST FAILED: phone_key should be 0244123456, got %', v_key using errcode = 'ZZ999';
  end if;

  -- The same number written three other ways must all collide.
  begin
    insert into customers (business_id, name, phone) select biz_a, 'Ama Again', '+233244123456' from c_ids;
    raise exception 'TEST FAILED: +233 form did not collide with the local form' using errcode = 'ZZ999';
  exception when unique_violation then
    raise notice 'PASS: +233244123456 collides with 024 412 3456';
  end;

  begin
    insert into customers (business_id, name, phone) select biz_a, 'Ama Again', '0244123456' from c_ids;
    raise exception 'TEST FAILED: unformatted form did not collide' using errcode = 'ZZ999';
  exception when unique_violation then
    raise notice 'PASS: 0244123456 collides too';
  end;

  -- A customer with no phone at all is fine, and several of them coexist.
  insert into customers (business_id, name) select biz_a, 'Walk-in One' from c_ids;
  insert into customers (business_id, name) select biz_a, 'Walk-in Two' from c_ids;
  raise notice 'PASS: multiple customers with no phone coexist';
end $$;

-- ── 2. Credit limit is enforced, not decorative ──────────────────────────

do $$
declare v_c uuid; v_balance numeric;
begin
  select id into v_c from customers where name = 'Ama Owusu';

  -- Within the 500 limit.
  insert into customer_account_entries (business_id, customer_id, amount, entry_type, note)
  values ('00000000-0000-0000-0000-000000000000', v_c, 200, 'charge', 'bag of rice');

  select balance into v_balance from customer_balances where customer_id = v_c;
  if v_balance <> 200 then
    raise exception 'TEST FAILED: expected balance 200, got %', v_balance using errcode = 'ZZ999';
  end if;

  -- Taking it to exactly the limit is allowed.
  insert into customer_account_entries (business_id, customer_id, amount, entry_type)
  values ('00000000-0000-0000-0000-000000000000', v_c, 300, 'charge');

  select balance into v_balance from customer_balances where customer_id = v_c;
  if v_balance <> 500 then
    raise exception 'TEST FAILED: expected balance 500 at the limit, got %', v_balance using errcode = 'ZZ999';
  end if;

  -- One pesewa over is not.
  begin
    insert into customer_account_entries (business_id, customer_id, amount, entry_type)
    values ('00000000-0000-0000-0000-000000000000', v_c, 0.01, 'charge');
    raise exception 'TEST FAILED: a charge exceeding the credit limit was accepted' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: charge over the credit limit rejected (%)', sqlerrm;
  end;

  select balance into v_balance from customer_balances where customer_id = v_c;
  if v_balance <> 500 then
    raise exception 'TEST FAILED: rejected charge still moved the balance to %', v_balance using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: rejected charge left the balance at 500';
end $$;

-- ── 3. The default limit of zero means cash only ─────────────────────────

do $$
declare v_c uuid; v_exists boolean;
begin
  select id into v_c from customers where name = 'Walk-in One';

  begin
    insert into customer_account_entries (business_id, customer_id, amount, entry_type)
    values ('00000000-0000-0000-0000-000000000000', v_c, 1, 'charge');
    raise exception 'TEST FAILED: a customer with no credit limit was charged on credit' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: default credit limit of 0 blocks credit entirely';
  end;

  select exists(select 1 from customer_balances where customer_id = v_c and balance <> 0) into v_exists;
  if v_exists then
    raise exception 'TEST FAILED: rejected charge left a non-zero balance behind' using errcode = 'ZZ999';
  end if;
end $$;

-- ── 4. Payments, including overpayment ───────────────────────────────────

do $$
declare v_c uuid; v_balance numeric; v_entry uuid; v_amount numeric;
begin
  select id into v_c from customers where name = 'Ama Owusu';

  select record_customer_payment(v_c, 200, (select branch_a from c_ids), 'part payment') into v_entry;

  select amount into v_amount from customer_account_entries where id = v_entry;
  if v_amount <> -200 then
    raise exception 'TEST FAILED: a payment of 200 should store as -200, got %', v_amount using errcode = 'ZZ999';
  end if;

  select balance into v_balance from customer_balances where customer_id = v_c;
  if v_balance <> 300 then
    raise exception 'TEST FAILED: expected 300 owing after paying 200 of 500, got %', v_balance using errcode = 'ZZ999';
  end if;

  -- Paying more than owed is legitimate — the customer is then in credit.
  perform record_customer_payment(v_c, 400, null, 'overpaid');
  select balance into v_balance from customer_balances where customer_id = v_c;
  if v_balance <> -100 then
    raise exception 'TEST FAILED: expected -100 (in credit), got %', v_balance using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: payments reduce the balance and overpayment leaves the customer in credit (-100)';

  -- A customer in credit can be charged again without touching the limit.
  insert into customer_account_entries (business_id, customer_id, amount, entry_type)
  values ('00000000-0000-0000-0000-000000000000', v_c, 100, 'charge');
  select balance into v_balance from customer_balances where customer_id = v_c;
  if v_balance <> 0 then
    raise exception 'TEST FAILED: expected 0 after charging 100 against 100 credit, got %', v_balance using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: charging against existing credit works and lands on 0';
end $$;

-- ── 5. A payment must be a payment ───────────────────────────────────────

do $$
declare v_c uuid;
begin
  select id into v_c from customers where name = 'Ama Owusu';

  begin
    perform record_customer_payment(v_c, 0, null, null);
    raise exception 'TEST FAILED: a zero payment was accepted' using errcode = 'ZZ999';
  exception when sqlstate '22023' then
    raise notice 'PASS: zero payment rejected';
  end;

  begin
    perform record_customer_payment(v_c, -50, null, null);
    raise exception 'TEST FAILED: a negative payment was accepted' using errcode = 'ZZ999';
  exception when sqlstate '22023' then
    raise notice 'PASS: negative payment rejected';
  end;

  begin
    insert into customer_account_entries (business_id, customer_id, amount, entry_type)
    values ('00000000-0000-0000-0000-000000000000', v_c, 0, 'adjustment');
    raise exception 'TEST FAILED: a zero-amount entry was accepted' using errcode = 'ZZ999';
  exception when check_violation then
    raise notice 'PASS: zero-amount entry rejected by the check constraint';
  end;
end $$;

-- ── 6. business_id and created_by are forced, not trusted ────────────────

do $$
declare v_c uuid; v_biz uuid; v_by uuid; v_biz_a uuid; v_biz_d uuid;
begin
  select biz_a, biz_d into v_biz_a, v_biz_d from c_ids;
  select id into v_c from customers where name = 'Ama Owusu';

  insert into customer_account_entries (business_id, customer_id, amount, entry_type, created_by)
  values (v_biz_d, v_c, -10, 'payment', '00000000-0000-0000-0000-000000000097');

  select business_id, created_by into v_biz, v_by
  from customer_account_entries order by created_at desc, id desc limit 1;

  if v_biz <> v_biz_a then
    raise exception 'TEST FAILED: spoofed business_id survived (%)', v_biz using errcode = 'ZZ999';
  end if;
  if v_by <> '00000000-0000-0000-0000-000000000001' then
    raise exception 'TEST FAILED: spoofed created_by survived (%)', v_by using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: business_id and created_by are overwritten from customer/session';
end $$;

-- ── 7. Reserved entry types are not insertable yet ───────────────────────

do $$
declare v_c uuid;
begin
  select id into v_c from customers where name = 'Ama Owusu';

  -- NOTE: 'sale' used to be asserted here as universally rejected. Since
  -- 0020 the sales phase exists and 'sale' is admitted for a caller with
  -- sales.process + customers.view; that rule is covered in
  -- tests/security/sales.sql. 'refund' below is still genuinely reserved.

  -- NOTE: 'refund' used to be asserted here as universally rejected. Since
  -- 0021 the refunds phase exists and it is admitted for a caller holding
  -- sales.refund + customers.view; the successor rule (allowed with the
  -- permissions, refused without) is covered in tests/security/refunds.sql.
  -- Both reserved types this file once guarded have now been claimed by
  -- the phases that generate them, which is the intended lifecycle.
  null;
end $$;

-- ── 8. The balance is not directly writable, and the ledger is final ─────

do $$
begin
  begin
    update customer_balances set balance = 0;
    raise exception 'TEST FAILED: customer_balances was directly UPDATEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: direct UPDATE on customer_balances refused (no grant)';
  end;

  begin
    insert into customer_balances (customer_id, business_id, balance)
    select id, business_id, 9999 from customers where name = 'Walk-in Two';
    raise exception 'TEST FAILED: customer_balances was directly INSERTable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: direct INSERT on customer_balances refused (no grant)';
  end;

  begin
    delete from customer_balances;
    raise exception 'TEST FAILED: customer_balances rows were DELETEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: direct DELETE on customer_balances refused (no grant)';
  end;

  begin
    update customer_account_entries set amount = 1;
    raise exception 'TEST FAILED: a ledger entry was UPDATEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: UPDATE on customer_account_entries refused (grant revoked)';
  end;

  begin
    delete from customer_account_entries;
    raise exception 'TEST FAILED: a ledger entry was DELETEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: DELETE on customer_account_entries refused (grant revoked)';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 9. Read-only role can look but not touch ─────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000097';

do $$
declare v_seen int; v_c uuid;
begin
  select count(*) into v_seen from customers;
  if v_seen < 1 then
    raise exception 'TEST FAILED: auditor holds customers.view but saw no customers' using errcode = 'ZZ999';
  end if;

  select count(*) into v_seen from customer_balances;
  if v_seen < 1 then
    raise exception 'TEST FAILED: auditor saw no balances' using errcode = 'ZZ999';
  end if;

  select id into v_c from customers where name = 'Ama Owusu';

  begin
    insert into customer_account_entries (business_id, customer_id, amount, entry_type)
    values ('00000000-0000-0000-0000-000000000000', v_c, 50, 'charge');
    raise exception 'TEST FAILED: auditor recorded a charge without customers.edit' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: auditor blocked from recording a charge';
  end;

  begin
    perform record_customer_payment(v_c, 10, null, null);
    raise exception 'TEST FAILED: auditor recorded a payment without customers.edit' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: auditor blocked from recording a payment';
  end;

  -- An RLS-denied UPDATE does NOT raise: the row simply falls outside the
  -- policy's USING clause, so the statement matches nothing and succeeds
  -- with 0 rows. (An INSERT is different — a failing WITH CHECK raises
  -- 42501, which is why the inserts above assert on an exception.) So the
  -- property to assert here is that the DATA did not move, not that an
  -- error appeared; asserting the latter would fail on correct code, and
  -- an assertion that merely expects "no exception" would prove nothing.
  declare
    v_rows int;
    v_limit_before numeric;
    v_limit_after numeric;
  begin
    select credit_limit into v_limit_before from customers where id = v_c;

    update customers set credit_limit = 99999 where id = v_c;
    get diagnostics v_rows = row_count;

    select credit_limit into v_limit_after from customers where id = v_c;

    if v_rows <> 0 then
      raise exception 'TEST FAILED: auditor''s credit-limit UPDATE touched % row(s)', v_rows using errcode = 'ZZ999';
    end if;
    if v_limit_after is distinct from v_limit_before then
      raise exception 'TEST FAILED: auditor changed a credit limit (% -> %)', v_limit_before, v_limit_after
        using errcode = 'ZZ999';
    end if;

    raise notice 'PASS: auditor cannot change a credit limit (0 rows, limit still %)', v_limit_after;
  end;

  -- Same silent-denial shape for an ordinary field.
  declare v_name_after text;
  begin
    update customers set name = 'Renamed By Auditor' where id = v_c;
    select name into v_name_after from customers where id = v_c;
    if v_name_after <> 'Ama Owusu' then
      raise exception 'TEST FAILED: auditor renamed a customer to %', v_name_after using errcode = 'ZZ999';
    end if;
    raise notice 'PASS: auditor cannot edit customer details either';
  end;

  raise notice 'PASS: read-only role can see customers and balances';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 10. Cross-tenant isolation ───────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000044';

do $$
declare v_seen int; v_c uuid; v_new uuid;
begin
  select count(*) into v_seen from customers;
  if v_seen <> 0 then
    raise exception 'TEST FAILED: business D owner saw % of business A''s customers', v_seen using errcode = 'ZZ999';
  end if;

  select count(*) into v_seen from customer_balances;
  if v_seen <> 0 then
    raise exception 'TEST FAILED: business D owner saw % of business A''s balances', v_seen using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: business D sees none of business A''s customers or balances';

  -- The same phone number in a DIFFERENT business is a different person
  -- and must be allowed — uniqueness is per business, not global.
  insert into customers (business_id, name, phone) select biz_d, 'Different Ama', '0244123456' from c_ids
  returning id into v_new;
  if v_new is null then
    raise exception 'TEST FAILED: could not reuse a phone number in another business' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: the same phone number is reusable in a different business';

  -- Business A's customer is invisible here, so an entry against them
  -- reports "not found" rather than leaking that they exist.
  select id into v_c from customers where name = 'Different Ama';
  begin
    insert into customer_account_entries (business_id, customer_id, branch_id, amount, entry_type)
    select biz_d, v_c, branch_a, 10, 'charge' from c_ids;
    raise exception 'TEST FAILED: attached business A''s branch to a business D entry' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0002' then raise notice 'PASS: foreign branch on an entry rejected (not visible)';
    when sqlstate 'P0001' then raise notice 'PASS: foreign branch on an entry rejected (business mismatch)';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 10b. The path the application actually takes ─────────────────────────
-- Every test above supplies a placeholder business_id, because the column
-- is NOT NULL. The Server Actions do NOT: they omit it entirely and let
-- set_customer_account_entry_context() fill it in. NOT NULL is checked
-- after BEFORE triggers, so this should work — but "should" is why it is
-- worth one test rather than an assumption.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_c uuid; v_id uuid; v_biz uuid; v_biz_a uuid;
begin
  select biz_a into v_biz_a from c_ids;
  select id into v_c from customers where name = 'Ama Owusu';

  -- business_id deliberately absent, exactly as the app inserts it.
  insert into customer_account_entries (customer_id, amount, entry_type, note)
  values (v_c, -25, 'payment', 'omitted business_id')
  returning id into v_id;

  select business_id into v_biz from customer_account_entries where id = v_id;
  if v_biz is distinct from v_biz_a then
    raise exception 'TEST FAILED: omitted business_id resolved to % (expected %)', v_biz, v_biz_a
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: an entry inserted without business_id (as the app does) is filled in correctly';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 11. Balances reconcile to the ledger ─────────────────────────────────

do $$
declare v_mismatches int;
begin
  select count(*) into v_mismatches
  from customer_balances b
  where b.balance is distinct from (
    select coalesce(sum(e.amount), 0)
    from customer_account_entries e
    where e.customer_id = b.customer_id
  );

  if v_mismatches <> 0 then
    raise exception 'TEST FAILED: % balance(s) disagree with their ledger', v_mismatches using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: every customer balance reconciles exactly to its ledger';
end $$;

\echo ''
\echo 'All customer tests passed.'
