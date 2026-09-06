-- Busihub — security test for cashier PINs (migrations 0018, 0039).
--
-- These cover holes that were real and reachable at various points, each
-- found by querying a live database as a Cashier rather than by reading
-- the schema:
--   1. any colleague could SELECT another profile's pin_hash (0018);
--   2. a user could clear their own PIN lockout counters (0018);
--   3. any authenticated user could verify ANY colleague's PIN, business-
--      wide, and so attribute a till sale to someone who never rang it up
--      (closed by 0039 — verify_profile_pin(p_pin) is now single-argument
--      and only ever checks the CALLER's own hash; there is no longer a
--      parameter to name anyone else with).
-- Tests 1 and 4 fail against the pre-0018 schema; test 3 fails against the
-- pre-0039 schema.
--
-- Run against a throwaway Postgres loaded with
-- tests/db-harness/00_stub_supabase.sql + supabase/migrations/*.sql +
-- supabase/seed.sql.
--
-- `TEST FAILED` raises use SQLSTATE ZZ999, which no handler here catches
-- (the default, P0001, is caught below as an *expected* rejection).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures: a Cashier (no users.manage) alongside the seeded Owner ─────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000099',
        'authenticated', 'authenticated', 'cashier@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

do $$
declare v_biz uuid; v_branch uuid; v_role uuid;
begin
  select id into v_biz from businesses where slug = 'busihub-demo-store';
  select id into v_branch from branches where business_id = v_biz and is_main;
  select id into v_role from roles where business_id = v_biz and name = 'Cashier';

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000099', v_biz, 'Demo', 'Cashier', 'cashier@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000000099', v_role,
            '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;

  if exists (
    select 1 from role_permissions rp join permissions p on p.id = rp.permission_id
    where rp.role_id = v_role and p.key = 'users.manage'
  ) then
    raise exception 'TEST FIXTURE BROKEN: Cashier unexpectedly holds users.manage' using errcode = 'ZZ999';
  end if;
end $$;

-- Both users get a PIN, set through the real function.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select set_profile_pin('00000000-0000-0000-0000-000000000001', '4821');
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000099';
select set_profile_pin('00000000-0000-0000-0000-000000000099', '1357');
reset role;
reset request.jwt.claim.sub;

-- ── 1. The hash is not readable by a colleague ───────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000099';

do $$
declare v_hash text;
begin
  begin
    select pin_hash into v_hash from profiles where id = '00000000-0000-0000-0000-000000000001';
    raise exception 'TEST FAILED: cashier read the owner''s pin_hash (%)', left(coalesce(v_hash, 'null'), 12)
      using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: pin_hash is not readable by a colleague';
  end;

  -- ...not even one's own, since nothing legitimate needs it client-side.
  begin
    select pin_hash into v_hash from profiles where id = '00000000-0000-0000-0000-000000000099';
    raise exception 'TEST FAILED: a user read their own pin_hash' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: pin_hash is not readable even by its owner';
  end;
end $$;

-- ── 2. Everything the application actually reads still works ─────────────
-- Narrowing a grant is exactly the kind of fix that breaks unrelated
-- pages, so the real queries are asserted rather than assumed.

do $$
declare v_name text; v_has_pin boolean; v_count int;
begin
  -- The (app) layout.
  select first_name into v_name from profiles where id = '00000000-0000-0000-0000-000000000099';
  if v_name is null then
    raise exception 'TEST FAILED: the layout''s profile query stopped working' using errcode = 'ZZ999';
  end if;

  -- Who has a PIN, without seeing any hash (used in admin/reporting views
  -- — the till itself, since 0039, only ever looks at the caller's own row).
  select count(*) into v_count from profiles where pin_set_at is not null;
  if v_count < 2 then
    raise exception 'TEST FAILED: expected 2 profiles with a PIN, saw %', v_count using errcode = 'ZZ999';
  end if;

  select pin_set_at is not null into v_has_pin from profiles where id = '00000000-0000-0000-0000-000000000001';
  if not v_has_pin then
    raise exception 'TEST FAILED: cannot tell whether a colleague has a PIN' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: names, and "has a PIN", remain readable — only the hash is hidden';
end $$;

-- ── 3. Verification is strictly self-only (0039) ─────────────────────────

do $$
begin
  if not verify_profile_pin('1357') then
    raise exception 'TEST FAILED: the correct PIN did not verify' using errcode = 'ZZ999';
  end if;
  if verify_profile_pin('9999') then
    raise exception 'TEST FAILED: a wrong PIN verified' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: correct PIN verifies, wrong PIN does not';

  -- 0039: verify_profile_pin() takes only the PIN itself now — there is no
  -- parameter left to name a colleague with. The strongest test available
  -- here is that knowing a COLLEAGUE's real PIN ('4821' is the Owner's)
  -- does not verify while signed in as the Cashier: it is checked only
  -- against the caller's own hash, so a PIN that is correct for someone
  -- else is simply wrong for this account.
  if verify_profile_pin('4821') then
    raise exception 'TEST FAILED: a colleague''s PIN verified against my own account' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a colleague''s PIN cannot be used to verify as them — there is no "verify as anyone else" call left to make';
end $$;

-- ── 4. The lockout cannot be cleared by the person it locks out ──────────

do $$
declare v_attempts int; v_locked timestamptz; v_rows int;
begin
  -- Enough wrong attempts to lock the account. Once it locks, further
  -- calls raise rather than return false, so the raise is swallowed here:
  -- the point of the loop is only to reach the locked state (the exact
  -- attempt it happens on depends on what earlier tests left behind).
  for i in 1..6 loop
    begin
      perform verify_profile_pin('0000');
    exception when sqlstate 'P0001' then
      null; -- already locked
    end;
  end loop;

  select pin_failed_attempts, pin_locked_until into v_attempts, v_locked
  from profiles where id = '00000000-0000-0000-0000-000000000099';

  if v_attempts < 5 then
    raise exception 'TEST FAILED: failed attempts not counted (got %)', v_attempts using errcode = 'ZZ999';
  end if;
  if v_locked is null or v_locked <= now() then
    raise exception 'TEST FAILED: account not locked after 5 wrong attempts' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: 5 wrong attempts locks the account until %', to_char(v_locked, 'HH24:MI');

  -- The whole point: the locked-out user cannot clear it themselves.
  -- An RLS-denied UPDATE would silently match 0 rows, so this asserts the
  -- data — but here the trigger raises outright, which is stronger.
  begin
    update profiles set pin_failed_attempts = 0, pin_locked_until = null
    where id = '00000000-0000-0000-0000-000000000099';
    get diagnostics v_rows = row_count;
    raise exception 'TEST FAILED: the locked-out user cleared their own lockout (% row(s))', v_rows
      using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a user cannot clear their own PIN lockout';
  end;

  select pin_locked_until into v_locked from profiles where id = '00000000-0000-0000-0000-000000000099';
  if v_locked is null then
    raise exception 'TEST FAILED: the lockout was cleared anyway' using errcode = 'ZZ999';
  end if;

  -- And while locked, even the RIGHT PIN is refused.
  begin
    perform verify_profile_pin('1357');
    raise exception 'TEST FAILED: a locked account accepted the correct PIN' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: while locked, even the correct PIN is refused';
  end;
end $$;

-- ── 5. Setting somebody else's PIN needs users.manage ────────────────────

do $$
begin
  begin
    perform set_profile_pin('00000000-0000-0000-0000-000000000001', '2468');
    raise exception 'TEST FAILED: a cashier set the owner''s PIN' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: setting another user''s PIN requires users.manage';
  end;

  -- Their own is fine, and it clears the lockout as a side effect —
  -- which is how a manager resets a locked-out cashier.
  perform set_profile_pin('00000000-0000-0000-0000-000000000099', '2468');
  if not verify_profile_pin('2468') then
    raise exception 'TEST FAILED: newly set PIN does not verify' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a user can set their own PIN, and doing so clears the lockout';
end $$;

-- ── 6. A weak PIN is refused even calling the function directly ──────────

do $$
declare v_pin text;
begin
  foreach v_pin in array array['12', '123', '1234567', 'abcd', '', '12a4', '1 34'] loop
    begin
      perform set_profile_pin('00000000-0000-0000-0000-000000000099', v_pin);
      raise exception 'TEST FAILED: a PIN of "%" was accepted', v_pin using errcode = 'ZZ999';
    exception when sqlstate '22023' then
      null; -- expected
    end;
  end loop;
  raise notice 'PASS: PINs outside 4-6 digits are refused by the function itself';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 7. Cross-tenant: verify_profile_pin() cannot even name a target ──────
-- Before 0039 this took (p_profile_id, p_pin) and merely checked that the
-- target's business matched the caller's — one bug away from leaking.
-- 0039 removed the parameter entirely, so that attack shape no longer has
-- a call to make. What is left to test: a user in a freshly registered
-- business, who has never set a PIN, cannot be routed to (or accidentally
-- match) anyone else's hash — the Cashier's real PIN in a DIFFERENT
-- business ('2468') is simply not a call this account can make.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000045',
        'authenticated', 'authenticated', 'ownere@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000045';
select register_business('PIN Test Shop E', 'Nana', 'Yaw');

do $$
begin
  begin
    perform verify_profile_pin('2468');
    raise exception 'TEST FAILED: verified with no PIN set on this account' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: verify_profile_pin() only ever looks at the caller''s own row — there is no cross-tenant call to make anymore';
  end;

  begin
    perform set_profile_pin('00000000-0000-0000-0000-000000000099', '1111');
    raise exception 'TEST FAILED: set another business''s PIN' using errcode = 'ZZ999';
  exception when sqlstate 'P0002' then
    raise notice 'PASS: another business''s PIN cannot be set';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

\echo ''
\echo 'All PIN security tests passed.'