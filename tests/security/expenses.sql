-- Busihub — behaviour/security tests for expenses (migration 0031).
--
-- Expenses are the first table in Busihub where the money moves OUT, and
-- three things follow from that which this file is mostly about:
--
--   * Recording one and being trusted to undo one are different acts.
--     A clerk who can write down the water bill must not be able to make
--     last month's rent disappear.
--   * A correction leaves a trail. An expense is voided with a reason,
--     never deleted, and its amount cannot be edited in place — so the
--     column grants are asserted, not just the policies.
--   * An RLS-denied UPDATE does not raise; it matches zero rows. Every
--     refusal below therefore checks that the DATA did not move, not
--     merely that something threw.
--
-- `TEST FAILED` raises carry SQLSTATE ZZ999, which no handler catches.

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000048',
   'authenticated', 'authenticated', 'clerk@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000049',
   'authenticated', 'authenticated', 'ownere@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

-- A second business, so every isolation assertion has somewhere to fail.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000049';
select register_business('Expense Test Shop E', 'Yaa', 'Boateng');
reset role;
reset request.jwt.claim.sub;

create table e_ids as
select
  (select id from businesses where slug = 'busihub-demo-store')   as biz_a,
  (select id from businesses where slug = 'expense-test-shop-e')  as biz_e,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'busihub-demo-store') and b.is_main)  as branch_a,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'expense-test-shop-e') and b.is_main) as branch_e;

grant select on e_ids to authenticated;

do $$
declare r record;
begin
  select * into r from e_ids;
  if r.biz_a is null or r.biz_e is null or r.branch_a is null or r.branch_e is null then
    raise exception 'TEST FIXTURE BROKEN: e_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

-- An Expense Clerk: may record and read expenses, may NOT void one or
-- touch the category list. That split is the whole point of the
-- permissions on this table, so the fixture guards that it is real.
do $$
declare v_biz uuid; v_branch uuid; v_role uuid;
begin
  select biz_a, branch_a into v_biz, v_branch from e_ids;

  insert into roles (business_id, name, description, is_system_role)
    values (v_biz, 'Expense Clerk', 'Records expenses only.', false)
    on conflict do nothing;
  select id into v_role from roles where business_id = v_biz and name = 'Expense Clerk';

  insert into role_permissions (role_id, permission_id)
    select v_role, id from permissions where key in ('expenses.view', 'expenses.create')
    on conflict do nothing;

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000048', v_biz, 'Ama', 'Clerk', 'clerk@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000000048', v_role,
            '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;

  if exists (
    select 1 from role_permissions rp join permissions p on p.id = rp.permission_id
    where rp.role_id = v_role and p.key = 'expenses.approve'
  ) then
    raise exception 'TEST FIXTURE BROKEN: the clerk holds expenses.approve' using errcode = 'ZZ999';
  end if;
end $$;

-- ── 1. Categories arrive with the business ──────────────────────────────

do $$
declare v_a int; v_e int; v_shared int;
begin
  select count(*) into v_a from expense_categories where business_id = (select biz_a from e_ids);
  select count(*) into v_e from expense_categories where business_id = (select biz_e from e_ids);

  if v_a = 0 then
    raise exception 'TEST FAILED: the existing business got no starting categories' using errcode = 'ZZ999';
  end if;
  -- The one that matters: the trigger fired for a business registered
  -- AFTER the migration ran, not just for the backfill.
  if v_e = 0 then
    raise exception 'TEST FAILED: a newly registered business got no categories' using errcode = 'ZZ999';
  end if;

  -- Per business, not a shared table. Two shops renaming "Other" must
  -- not rename it for each other.
  select count(*) into v_shared from expense_categories c1
  join expense_categories c2 on c2.id = c1.id
  where c1.business_id <> c2.business_id;
  if v_shared <> 0 then
    raise exception 'TEST FAILED: a category row is shared between businesses' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: every business gets its own starting categories (% and %)', v_a, v_e;
end $$;

-- ── 2. Recording one, and what it refuses ───────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare
  v_id uuid; v_row record; v_before int;
begin
  select count(*) into v_before from expenses;

  v_id := create_expense((select branch_a from e_ids),
    (select id from expense_categories where business_id = (select biz_a from e_ids) and name = 'Rent'),
    '  August rent  ', 800, current_date, 'bank', 'CHQ-0012', null);

  select * into v_row from expenses where id = v_id;
  if v_row.business_id <> (select biz_a from e_ids) then
    raise exception 'TEST FAILED: the expense landed on the wrong business' using errcode = 'ZZ999';
  end if;
  if v_row.recorded_by <> '00000000-0000-0000-0000-000000000001' then
    raise exception 'TEST FAILED: attribution was not taken from the session' using errcode = 'ZZ999';
  end if;
  if v_row.description <> 'August rent' then
    raise exception 'TEST FAILED: description was not trimmed (got "%")', v_row.description
      using errcode = 'ZZ999';
  end if;
  if v_row.status <> 'recorded' then
    raise exception 'TEST FAILED: a new expense should be recorded, got %', v_row.status
      using errcode = 'ZZ999';
  end if;

  -- Money that has not left yet is not an expense. Allowing a future
  -- date is the easiest way to move a bad month into a good one.
  begin
    perform create_expense((select branch_a from e_ids), null, 'Next month''s rent', 800,
      current_date + 1, 'bank', null, null);
    raise exception 'TEST FAILED: a future-dated expense was accepted' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a future-dated expense is refused (%)', sqlerrm;
  end;

  begin
    perform create_expense((select branch_a from e_ids), null, 'Nothing', 0,
      current_date, 'cash', null, null);
    raise exception 'TEST FAILED: a zero-amount expense was accepted' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a zero amount is refused (%)', sqlerrm;
  end;

  begin
    perform create_expense((select branch_a from e_ids), null, '   ', 50,
      current_date, 'cash', null, null);
    raise exception 'TEST FAILED: a blank description was accepted' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a blank description is refused (%)', sqlerrm;
  end;

  begin
    perform create_expense((select branch_a from e_ids), null, 'Paid somehow', 50,
      current_date, 'bitcoin', null, null);
    raise exception 'TEST FAILED: an unknown payment source was accepted' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: an unknown payment source is refused (%)', sqlerrm;
  end;

  -- Every refusal above must have left nothing behind. A half-recorded
  -- expense is worse than a refused one.
  if (select count(*) from expenses) <> v_before + 1 then
    raise exception 'TEST FAILED: a refused expense left a row behind' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: an expense derives its business and its author, and refusals leave nothing behind';
end $$;

-- ── 3. Reference numbers are per business ───────────────────────────────

do $$
declare v_highest int; v_second text; v_id uuid;
begin
  -- The highest number this business has used SO FAR, read before the
  -- next expense exists. Asserting a literal 'EX-000002' here would make
  -- the file depend on nothing else having recorded an expense first —
  -- exactly the fixture-order assumption that broke refunds.sql.
  select coalesce(max((substring(reference_number from '^EX-([0-9]+)$'))::int), 0)
  into v_highest
  from expenses
  where business_id = (select biz_a from e_ids) and reference_number ~ '^EX-[0-9]+$';

  v_id := create_expense((select branch_a from e_ids), null, 'Rope and nails', 12,
    current_date, 'cash', null, null);
  select reference_number into v_second from expenses where id = v_id;

  if v_second !~ '^EX-[0-9]{6}$' then
    raise exception 'TEST FAILED: reference number is not EX-nnnnnn (%)', v_second using errcode = 'ZZ999';
  end if;
  if v_second <> 'EX-' || lpad((v_highest + 1)::text, 6, '0') then
    raise exception 'TEST FAILED: expected EX-%, got %', lpad((v_highest + 1)::text, 6, '0'), v_second
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: reference numbers run in sequence, per business (%)', v_second;
end $$;

reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000049';

do $$
declare v_id uuid; v_ref text;
begin
  -- A different business starts its own count. If the sequence were
  -- global, this shop's first expense would announce how many the
  -- neighbour has recorded.
  v_id := create_expense((select branch_e from e_ids), null, 'Signboard', 60,
    current_date, 'cash', null, null);
  select reference_number into v_ref from expenses where id = v_id;

  if v_ref <> 'EX-000001' then
    raise exception 'TEST FAILED: a second business''s first expense was %, not EX-000001', v_ref
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: each business numbers its expenses from one';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 4. A clerk may record, but not undo ─────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000048';

do $$
declare v_id uuid; v_target uuid; v_status text;
begin
  -- Recording works: this is the permission the clerk has.
  v_id := create_expense((select branch_a from e_ids), null, 'Sachet water for the shop', 20,
    current_date, 'cash', null, null);
  if v_id is null then
    raise exception 'TEST FAILED: a clerk with expenses.create could not record one' using errcode = 'ZZ999';
  end if;

  select id into v_target from expenses
  where business_id = (select biz_a from e_ids) and description = 'August rent';

  -- Voiding does not. And it must RAISE: an RLS-denied UPDATE matches
  -- zero rows and returns quietly, so a function that does not check
  -- would tell the clerk the rent had been cancelled when it had not.
  begin
    perform void_expense(v_target, 'Changed my mind');
    raise exception 'TEST FAILED: a clerk without expenses.approve voided an expense'
      using errcode = 'ZZ999';
  exception when sqlstate '42501' then
    raise notice 'PASS: voiding is refused without expenses.approve (%)', sqlerrm;
  end;

  select status into v_status from expenses where id = v_target;
  if v_status <> 'recorded' then
    raise exception 'TEST FAILED: the refused void changed the expense anyway (now %)', v_status
      using errcode = 'ZZ999';
  end if;

  -- The category list is not theirs to reshape either.
  begin
    insert into expense_categories (business_id, name)
    values ((select biz_a from e_ids), 'Clerk''s own category');
    raise exception 'TEST FAILED: a clerk added a category' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: shaping the category list needs expenses.approve';
  end;

  raise notice 'PASS: recording an expense and undoing one are separate permissions';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 5. Someone with no expenses permission at all ───────────────────────
--
-- The Cashier: sells all day, and has no business seeing what the shop
-- pays in rent.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000095';

do $$
declare v_n int; v_total numeric; v_before int;
begin
  select count(*) into v_n from expenses;
  if v_n <> 0 then
    raise exception 'TEST FAILED: a cashier can read % expense rows', v_n using errcode = 'ZZ999';
  end if;

  select expense_total into v_total from expense_summary();
  if v_total <> 0 then
    raise exception 'TEST FAILED: a cashier was told the shop spent %', v_total using errcode = 'ZZ999';
  end if;

  select count(*) into v_before from expenses;
  begin
    perform create_expense((select branch_a from e_ids), null, 'Cashier expense', 5,
      current_date, 'cash', null, null);
    raise exception 'TEST FAILED: a cashier recorded an expense' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: recording an expense needs expenses.create';
  end;

  raise notice 'PASS: a cashier can neither see nor record expenses';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 6. Voiding: with a reason, once, and it stops counting ──────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare
  v_target uuid; v_before numeric; v_after numeric; v_row record; v_listed int;
begin
  select id into v_target from expenses
  where business_id = (select biz_a from e_ids) and description = 'August rent';
  select expense_total into v_before from expense_summary(null, null, (select branch_a from e_ids));

  -- A void with no reason is an unexplained hole in the month.
  begin
    perform void_expense(v_target, '   ');
    raise exception 'TEST FAILED: an expense was voided with no reason' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: voiding requires a reason (%)', sqlerrm;
  end;

  perform void_expense(v_target, 'Recorded twice by mistake');

  select * into v_row from expenses where id = v_target;
  if v_row.status <> 'voided' or v_row.voided_by is null or v_row.voided_at is null
     or v_row.void_reason <> 'Recorded twice by mistake' then
    raise exception 'TEST FAILED: the void did not record who, when and why' using errcode = 'ZZ999';
  end if;

  select expense_total into v_after from expense_summary(null, null, (select branch_a from e_ids));
  if v_after <> v_before - 800.00 then
    raise exception 'TEST FAILED: voiding 800.00 moved the total from % to %', v_before, v_after
      using errcode = 'ZZ999';
  end if;

  -- Gone from the figures, still on the page. A record that vanishes is
  -- a record nobody can audit.
  select count(*) into v_listed from expenses where id = v_target;
  if v_listed <> 1 then
    raise exception 'TEST FAILED: the voided expense disappeared from the ledger' using errcode = 'ZZ999';
  end if;

  begin
    perform void_expense(v_target, 'Again');
    raise exception 'TEST FAILED: an expense was voided twice' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: an expense cannot be voided twice (%)', sqlerrm;
  end;

  raise notice 'PASS: voiding needs a reason, stops the expense counting, and leaves it on the page';
end $$;

-- ── 6b. Not even the owner may edit an amount in place ──────────────────
--
-- This is the column grant, not the policy — and it has to be tested as
-- somebody the POLICY allows, or it proves nothing. The owner holds
-- expenses.approve, so the update policy lets them through and the only
-- thing standing between them and a rewritten amount is the column-level
-- grant. A table-level GRANT UPDATE authorises every column regardless of
-- any per-column revoke, which is why 0031 revokes the table grant before
-- issuing the narrow one (the same trap as profiles.pin_hash in 0018).
--
-- Correcting an expense means voiding it and recording the right one, so
-- both stay on the page. An editable amount is an unauditable one.

do $$
declare v_target uuid; v_amount numeric; v_date date; v_refused boolean := false;
begin
  select id, amount, expense_date into v_target, v_amount, v_date
  from expenses
  where business_id = (select biz_a from e_ids) and status = 'recorded'
  order by created_at limit 1;

  begin
    update expenses set amount = 1 where id = v_target;
  exception when insufficient_privilege then
    v_refused := true;
  end;
  if (select amount from expenses where id = v_target) <> v_amount then
    raise exception 'TEST FAILED: the owner edited an expense amount in place' using errcode = 'ZZ999';
  end if;
  if not v_refused then
    raise exception 'TEST FAILED: updating amount was permitted (it matched no rows, but the grant stands)'
      using errcode = 'ZZ999';
  end if;

  -- Same for the date: moving an expense into another month is how a bad
  -- month is made to look good, and it is the same grant that stops it.
  v_refused := false;
  begin
    update expenses set expense_date = current_date - 40 where id = v_target;
  exception when insufficient_privilege then
    v_refused := true;
  end;
  if not v_refused or (select expense_date from expenses where id = v_target) <> v_date then
    raise exception 'TEST FAILED: an expense was moved to another date' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: an expense''s amount and date cannot be edited in place by anyone';
end $$;

-- ── 7. The parts sum to the whole ───────────────────────────────────────

do $$
declare v_total numeric; v_by_category numeric; v_uncategorised numeric;
begin
  select expense_total into v_total from expense_summary(null, null, (select branch_a from e_ids));
  select coalesce(sum(amount), 0) into v_by_category
  from expenses_by_category(null, null, (select branch_a from e_ids), 100);

  if v_total <> v_by_category then
    raise exception 'TEST FAILED: the category breakdown comes to % but the total is %',
      v_by_category, v_total using errcode = 'ZZ999';
  end if;

  -- An expense with no category must appear as Uncategorised rather than
  -- being dropped, which is what would make the two disagree.
  select coalesce(sum(amount), 0) into v_uncategorised
  from expenses_by_category(null, null, (select branch_a from e_ids), 100)
  where category_name = 'Uncategorised';
  if v_uncategorised <= 0 then
    raise exception 'TEST FAILED: expenses with no category were dropped from the breakdown'
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: the category breakdown sums to the total, uncategorised included';
end $$;

-- ── 8. The drawer ───────────────────────────────────────────────────────

do $$
declare
  v_before record; v_after record; v_id uuid;
begin
  select * into v_before from cash_drawer_summary(null, null, null, null, (select branch_a from e_ids));

  if v_before.expected_in_drawer <> v_before.cash_taken - v_before.cash_paid_out then
    raise exception 'TEST FAILED: expected % is not taken % less paid out %',
      v_before.expected_in_drawer, v_before.cash_taken, v_before.cash_paid_out using errcode = 'ZZ999';
  end if;

  -- Paying the water bill out of the till is exactly why paid_from
  -- exists: the drawer must come up 45.50 short and be able to say why.
  v_id := create_expense((select branch_a from e_ids), null, 'Water bill from the till', 45.50,
    current_date, 'cash', null, null);

  select * into v_after from cash_drawer_summary(null, null, null, null, (select branch_a from e_ids));
  if v_after.cash_paid_out <> v_before.cash_paid_out + 45.50 then
    raise exception 'TEST FAILED: a cash expense did not come out of the drawer (% -> %)',
      v_before.cash_paid_out, v_after.cash_paid_out using errcode = 'ZZ999';
  end if;
  if v_after.cash_taken <> v_before.cash_taken then
    raise exception 'TEST FAILED: paying an expense changed the takings' using errcode = 'ZZ999';
  end if;

  -- ...but paying by bank transfer must not touch the drawer at all.
  perform create_expense((select branch_a from e_ids), null, 'Insurance by transfer', 300,
    current_date, 'bank', null, null);

  select * into v_after from cash_drawer_summary(null, null, null, null, (select branch_a from e_ids));
  if v_after.cash_paid_out <> v_before.cash_paid_out + 45.50 then
    raise exception 'TEST FAILED: a bank expense came out of the cash drawer' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: only cash expenses come out of the drawer, and the takings are untouched';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 9. None of it belongs to anyone else ────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000049';

do $$
declare v_n int; v_total numeric; v_drawer record;
begin
  -- Shop E recorded exactly one expense, for 60.00. Everything above
  -- belongs to shop A and none of it may show up here.
  select expense_total, expense_count into v_total, v_n from expense_summary();
  if v_total <> 60.00 or v_n <> 1 then
    raise exception 'TEST FAILED: another business''s expenses are visible (% over % rows)', v_total, v_n
      using errcode = 'ZZ999';
  end if;

  select count(*) into v_n from expenses where business_id = (select biz_a from e_ids);
  if v_n <> 0 then
    raise exception 'TEST FAILED: % of another business''s expense rows are readable', v_n
      using errcode = 'ZZ999';
  end if;

  select count(*) into v_n from expense_categories where business_id = (select biz_a from e_ids);
  if v_n <> 0 then
    raise exception 'TEST FAILED: another business''s categories are readable' using errcode = 'ZZ999';
  end if;

  -- Naming their branch is not a way in: the filter narrows what RLS
  -- already allowed, it cannot widen it.
  select expense_total into v_total from expense_summary(null, null, (select branch_a from e_ids));
  if v_total <> 0 then
    raise exception 'TEST FAILED: naming another business''s branch returned % of their spending', v_total
      using errcode = 'ZZ999';
  end if;

  select * into v_drawer from cash_drawer_summary(null, null, null, null, (select branch_a from e_ids));
  if v_drawer.cash_taken <> 0 or v_drawer.cash_paid_out <> 0 then
    raise exception 'TEST FAILED: another business''s drawer was readable (% in, % out)',
      v_drawer.cash_taken, v_drawer.cash_paid_out using errcode = 'ZZ999';
  end if;

  -- Recording INTO their branch must fail too, not quietly file the
  -- expense against the wrong shop.
  begin
    perform create_expense((select branch_a from e_ids), null, 'Not my shop', 10,
      current_date, 'cash', null, null);
    raise exception 'TEST FAILED: an expense was recorded against another business''s branch'
      using errcode = 'ZZ999';
  exception when insufficient_privilege or sqlstate 'P0002' then
    raise notice 'PASS: recording against another business''s branch is refused (%)', sqlerrm;
  end;

  raise notice 'PASS: a second business sees and touches none of the first business''s spending';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 10. The trigger's own guarantees ────────────────────────────────────
--
-- set_expense_context() does two things RLS cannot: it OVERWRITES the
-- business_id on the row, and it refuses a branch and a category that
-- belong to different businesses.
--
-- Neither can be reached through the application today, and that is
-- worth stating rather than leaving implied: branches_select is scoped by
-- app_current_business_id(), so a person sees exactly one business's
-- branches and cannot hold the two ids needed to make the pairing. The
-- guard is there for the day that stops being true — a user in two
-- businesses is an ordinary thing to want, and the check must already be
-- in place when it arrives rather than being remembered then.
--
-- So these are tested against the trigger directly, with RLS out of the
-- way. That is the only way to reach a code path RLS currently makes
-- unreachable, and a guard that has never once been executed is a guard
-- nobody should rely on.

do $$
declare v_foreign uuid; v_before int; v_id uuid; v_landed uuid;
begin
  select count(*) into v_before from expenses;
  select id into v_foreign from expense_categories
  where business_id = (select biz_e from e_ids) limit 1;

  -- Shop A's branch, shop E's category.
  begin
    insert into expenses (
      business_id, branch_id, category_id, reference_number, description,
      amount, expense_date, paid_from
    )
    values (
      (select biz_a from e_ids), (select branch_a from e_ids), v_foreign,
      'EX-999001', 'Cross-tenant category', 10, current_date, 'cash'
    );
    raise exception 'TEST FAILED: an expense was filed under another business''s category'
      using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a branch and a category from different businesses are refused (%)', sqlerrm;
  end;

  if (select count(*) from expenses) <> v_before then
    raise exception 'TEST FAILED: the refused expense left a row behind' using errcode = 'ZZ999';
  end if;

  -- A forged business_id is not merely rejected, it is IGNORED: the
  -- trigger derives the value from the branch and overwrites whatever
  -- the payload said. This is what makes "a business id from the browser
  -- is worth nothing" true at the table rather than only in the page.
  insert into expenses (
    business_id, branch_id, reference_number, description,
    amount, expense_date, paid_from
  )
  values (
    (select biz_e from e_ids),          -- a lie
    (select branch_a from e_ids),       -- the truth
    'EX-999002', 'Forged business id', 10, current_date, 'cash'
  )
  returning id into v_id;

  select business_id into v_landed from expenses where id = v_id;
  if v_landed <> (select biz_a from e_ids) then
    raise exception 'TEST FAILED: a forged business_id survived (landed on %)', v_landed
      using errcode = 'ZZ999';
  end if;

  delete from expenses where id = v_id;
  raise notice 'PASS: the trigger derives business_id from the branch and ignores what was sent';
end $$;

-- And the premise above, asserted rather than assumed: a person sees one
-- business's branches. If this ever changes, the pairing tested above
-- becomes reachable and this assertion is the thing that says so.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000049';

do $$
declare v_n int;
begin
  select count(*) into v_n from branches where business_id = (select biz_a from e_ids);
  if v_n <> 0 then
    raise exception 'TEST FAILED: another business''s branches are visible (% of them)', v_n
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: branch visibility is scoped to one business, so the cross-pairing is unreachable';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 11. The one-word regression ─────────────────────────────────────────

do $$
declare v_bad text;
begin
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and p.proname in (
      'expense_summary', 'expenses_by_category', 'cash_drawer_summary',
      'create_expense', 'void_expense'
    );
  if v_bad is not null then
    raise exception 'TEST FAILED: expense function(s) are SECURITY DEFINER and bypass RLS: %', v_bad
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: every expense function runs as the caller, so RLS scopes it';
end $$;