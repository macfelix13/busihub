-- Busihub — security tests for staff management (migration 0036).
--
-- Covers the three new SECURITY DEFINER functions (invite_staff_member,
-- update_staff_role, set_staff_status): that ordinary permission
-- enforcement holds (no users.manage → refused), the Owner-escalation
-- guard (granting Owner needs business.manage, not just users.manage),
-- the last-Owner lockout guard, the self-action guard, and cross-tenant
-- isolation (IDs from a foreign business are rejected even though none
-- of these functions accept a business_id argument at all — the
-- caller's own business_id is always looked up server-side).
--
-- Run against a throwaway Postgres loaded with
-- tests/db-harness/00_stub_supabase.sql + supabase/migrations/*.sql +
-- supabase/seed.sql (+ every earlier tests/security/*.sql file, per
-- .github/workflows/ci.yml's run order — this file assumes the seeded
-- 'busihub-demo-store' business and its Owner, 00000000-...-0001, exist).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ──────────────────────────────────────────────────────────────
-- 05xx block: not used by any other tests/security/*.sql file (checked).

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000501', 'authenticated', 'authenticated', 'staffmgr@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000502', 'authenticated', 'authenticated', 'staffowner2@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000503', 'authenticated', 'authenticated', 'staffcashier@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000504', 'authenticated', 'authenticated', 'staffdupe@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

do $$
declare
  v_biz uuid;
  v_branch uuid;
  v_manager_role uuid;
  v_cashier_role uuid;
begin
  select id into v_biz from businesses where slug = 'busihub-demo-store';
  select id into v_branch from branches where business_id = v_biz and is_main;
  select id into v_manager_role from roles where business_id = v_biz and name = 'Manager';
  select id into v_cashier_role from roles where business_id = v_biz and name = 'Cashier';

  if v_biz is null or v_branch is null or v_manager_role is null or v_cashier_role is null then
    raise exception 'TEST FIXTURE BROKEN: seeded demo store/roles missing' using errcode = 'ZZ999';
  end if;
end $$;

-- ── 1. Owner invites a Manager (happy path) ──────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare
  v_biz uuid; v_branch uuid; v_manager_role uuid;
  v_profile_count int; v_ubr_count int; v_audit_count int;
begin
  select id into v_biz from businesses where slug = 'busihub-demo-store';
  select id into v_branch from branches where business_id = v_biz and is_main;
  select id into v_manager_role from roles where business_id = v_biz and name = 'Manager';

  perform invite_staff_member('00000000-0000-0000-0000-000000000501', v_branch, v_manager_role, 'Fixture', 'Manager', 'staffmgr@busihub.dev.example');

  select count(*) into v_profile_count from profiles where id = '00000000-0000-0000-0000-000000000501' and business_id = v_biz;
  select count(*) into v_ubr_count from user_branch_roles where user_id = '00000000-0000-0000-0000-000000000501' and role_id = v_manager_role;
  select count(*) into v_audit_count from audit_logs where action = 'user.invited' and resource_id = '00000000-0000-0000-0000-000000000501';

  if v_profile_count <> 1 then
    raise exception 'TEST FAILED: invite_staff_member did not create the profile' using errcode = 'ZZ999';
  end if;
  if v_ubr_count <> 1 then
    raise exception 'TEST FAILED: invite_staff_member did not assign the role' using errcode = 'ZZ999';
  end if;
  if v_audit_count <> 1 then
    raise exception 'TEST FAILED: invite was not audit-logged' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: Owner can invite a Manager; profile, role, and audit row all created';
end $$;

-- Re-inviting the same (now-profiled) account is rejected.
do $$
begin
  begin
    perform invite_staff_member('00000000-0000-0000-0000-000000000501', (select id from branches where is_main and business_id = (select id from businesses where slug = 'busihub-demo-store')), (select id from roles where business_id = (select id from businesses where slug = 'busihub-demo-store') and name = 'Cashier'), 'Fixture', 'Manager', 'staffmgr@busihub.dev.example');
    raise exception 'TEST FAILED: re-invited an account that already has a profile' using errcode = 'ZZ999';
  exception when unique_violation then
    raise notice 'PASS: an account that already has a profile cannot be invited again';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 2. A Cashier cannot invite anyone ─────────────────────────────────────

-- Bootstrap a Cashier fixture directly (not via invite — that's tested
-- separately below via the new Manager) so this test doesn't depend on
-- test ordering within this file.
do $$
declare v_biz uuid; v_branch uuid; v_role uuid;
begin
  select id into v_biz from businesses where slug = 'busihub-demo-store';
  select id into v_branch from branches where business_id = v_biz and is_main;
  select id into v_role from roles where business_id = v_biz and name = 'Cashier';

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000503', v_biz, 'Fixture', 'Cashier', 'staffcashier@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000000503', v_role, '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;
end $$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000503';

do $$
declare v_biz uuid; v_branch uuid; v_role uuid;
begin
  select id into v_biz from businesses where slug = 'busihub-demo-store';
  select id into v_branch from branches where business_id = v_biz and is_main;
  select id into v_role from roles where business_id = v_biz and name = 'Cashier';

  begin
    perform invite_staff_member('00000000-0000-0000-0000-000000000504', v_branch, v_role, 'Should', 'Fail', 'staffdupe@busihub.dev.example');
    raise exception 'TEST FAILED: a Cashier (no users.manage) invited staff' using errcode = 'ZZ999';
  exception when sqlstate '42501' then
    raise notice 'PASS: inviting staff requires users.manage';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 3. A Manager cannot grant the Owner role; an Owner can ───────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000501';

do $$
declare v_biz uuid; v_branch uuid; v_owner_role uuid;
begin
  select id into v_biz from businesses where slug = 'busihub-demo-store';
  select id into v_branch from branches where business_id = v_biz and is_main;
  select id into v_owner_role from roles where business_id = v_biz and name = 'Owner';

  begin
    perform invite_staff_member('00000000-0000-0000-0000-000000000502', v_branch, v_owner_role, 'Should', 'Fail', 'staffowner2@busihub.dev.example');
    raise exception 'TEST FAILED: a Manager (no business.manage) granted the Owner role' using errcode = 'ZZ999';
  exception when sqlstate '42501' then
    raise notice 'PASS: granting the Owner role requires business.manage, not just users.manage';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_biz uuid; v_branch uuid; v_owner_role uuid; v_count int;
begin
  select id into v_biz from businesses where slug = 'busihub-demo-store';
  select id into v_branch from branches where business_id = v_biz and is_main;
  select id into v_owner_role from roles where business_id = v_biz and name = 'Owner';

  perform invite_staff_member('00000000-0000-0000-0000-000000000502', v_branch, v_owner_role, 'Second', 'Owner', 'staffowner2@busihub.dev.example');

  select count(*) into v_count from user_branch_roles where user_id = '00000000-0000-0000-0000-000000000502' and role_id = v_owner_role;
  if v_count <> 1 then
    raise exception 'TEST FAILED: the real Owner could not grant the Owner role' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: an Owner (business.manage) can grant the Owner role';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 4. Cross-tenant: a foreign business's branch/role ids are rejected ──

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000599', 'authenticated', 'authenticated', 'staffforeign@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000599';
select register_business('Staff Test Shop 599', 'Foreign', 'Owner');
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_foreign_branch uuid; v_foreign_role uuid;
begin
  select id into v_foreign_branch from branches where business_id = (select id from businesses where created_by = '00000000-0000-0000-0000-000000000599') and is_main;
  select id into v_foreign_role from roles where business_id = (select business_id from branches where id = v_foreign_branch) and name = 'Cashier';

  begin
    perform invite_staff_member('00000000-0000-0000-0000-000000000504', v_foreign_branch, v_foreign_role, 'Should', 'Fail', 'staffdupe@busihub.dev.example');
    raise exception 'TEST FAILED: invited staff into a branch belonging to another business' using errcode = 'ZZ999';
  exception when sqlstate '22023' then
    raise notice 'PASS: a foreign business''s branch/role ids are rejected — the caller''s own business_id is always used, never a client-supplied one';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 5. update_staff_role: self-action, escalation, and lockout guards ────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_biz uuid; v_branch uuid; v_manager_role uuid; v_owner_role uuid;
begin
  select id into v_biz from businesses where slug = 'busihub-demo-store';
  select id into v_branch from branches where business_id = v_biz and is_main;
  select id into v_manager_role from roles where business_id = v_biz and name = 'Manager';
  select id into v_owner_role from roles where business_id = v_biz and name = 'Owner';

  -- Cannot act on your own row.
  begin
    perform update_staff_role('00000000-0000-0000-0000-000000000001', v_branch, v_manager_role);
    raise exception 'TEST FAILED: the Owner changed their own role' using errcode = 'ZZ999';
  exception when sqlstate '42501' then
    raise notice 'PASS: cannot change your own role';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- As the (non-business.manage) Manager, try to elevate the Cashier to Owner.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000501';

do $$
declare v_biz uuid; v_branch uuid; v_owner_role uuid;
begin
  select id into v_biz from businesses where slug = 'busihub-demo-store';
  select id into v_branch from branches where business_id = v_biz and is_main;
  select id into v_owner_role from roles where business_id = v_biz and name = 'Owner';

  begin
    perform update_staff_role('00000000-0000-0000-0000-000000000503', v_branch, v_owner_role);
    raise exception 'TEST FAILED: a Manager elevated a colleague to Owner' using errcode = 'ZZ999';
  exception when sqlstate '42501' then
    raise notice 'PASS: elevating a colleague to Owner requires business.manage';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- As the Manager (users.manage, not the target), demote the Cashier to
-- Manager — allowed, and replaces rather than duplicates the role row.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000501';

do $$
declare v_biz uuid; v_branch uuid; v_manager_role uuid; v_row_count int;
begin
  select id into v_biz from businesses where slug = 'busihub-demo-store';
  select id into v_branch from branches where business_id = v_biz and is_main;
  select id into v_manager_role from roles where business_id = v_biz and name = 'Manager';

  perform update_staff_role('00000000-0000-0000-0000-000000000503', v_branch, v_manager_role);

  select count(*) into v_row_count from user_branch_roles
    where user_id = '00000000-0000-0000-0000-000000000503' and branch_id = v_branch;
  if v_row_count <> 1 then
    raise exception 'TEST FAILED: expected exactly 1 role row after the change, got %', v_row_count using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a role change replaces, rather than duplicates, the branch role row';
end $$;

reset role;
reset request.jwt.claim.sub;

-- Last-Owner guard: the second Owner (…0502) demoting the FIRST Owner
-- (…0001) is fine (two Owners exist); demoting the only remaining one
-- afterward must be refused.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000502';

do $$
declare v_biz uuid; v_branch uuid; v_manager_role uuid;
begin
  select id into v_biz from businesses where slug = 'busihub-demo-store';
  select id into v_branch from branches where business_id = v_biz and is_main;
  select id into v_manager_role from roles where business_id = v_biz and name = 'Manager';

  perform update_staff_role('00000000-0000-0000-0000-000000000001', v_branch, v_manager_role);
  raise notice 'PASS: demoting one of two Owners is allowed';
end $$;

reset role;
reset request.jwt.claim.sub;

-- Now only …0502 is an active Owner. A super admin path isn't available
-- here, so use …0501 (Manager, users.manage) to attempt to demote the
-- last Owner — must be refused regardless of who's asking.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000501';

do $$
declare v_biz uuid; v_branch uuid; v_manager_role uuid;
begin
  select id into v_biz from businesses where slug = 'busihub-demo-store';
  select id into v_branch from branches where business_id = v_biz and is_main;
  select id into v_manager_role from roles where business_id = v_biz and name = 'Manager';

  begin
    perform update_staff_role('00000000-0000-0000-0000-000000000502', v_branch, v_manager_role);
    raise exception 'TEST FAILED: demoted the business''s only remaining active Owner' using errcode = 'ZZ999';
  exception when sqlstate '22023' then
    raise notice 'PASS: cannot demote the business''s only remaining active Owner';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 6. set_staff_status: self-action, last-Owner, and the happy path ────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000501';

do $$
begin
  -- Cannot deactivate yourself.
  begin
    perform set_staff_status('00000000-0000-0000-0000-000000000501', 'inactive');
    raise exception 'TEST FAILED: a manager deactivated themselves' using errcode = 'ZZ999';
  exception when sqlstate '42501' then
    raise notice 'PASS: cannot change your own status';
  end;

  -- Cannot deactivate the only remaining active Owner.
  begin
    perform set_staff_status('00000000-0000-0000-0000-000000000502', 'inactive');
    raise exception 'TEST FAILED: deactivated the business''s only remaining active Owner' using errcode = 'ZZ999';
  exception when sqlstate '22023' then
    raise notice 'PASS: cannot deactivate the business''s only remaining active Owner';
  end;
end $$;

-- Happy path: deactivate, then reactivate, the (now-Manager) former Cashier.
do $$
declare v_status profile_status; v_deactivated_count int; v_reactivated_count int;
begin
  perform set_staff_status('00000000-0000-0000-0000-000000000503', 'inactive');
  select status into v_status from profiles where id = '00000000-0000-0000-0000-000000000503';
  if v_status <> 'inactive' then
    raise exception 'TEST FAILED: status did not change to inactive' using errcode = 'ZZ999';
  end if;

  perform set_staff_status('00000000-0000-0000-0000-000000000503', 'active');
  select status into v_status from profiles where id = '00000000-0000-0000-0000-000000000503';
  if v_status <> 'active' then
    raise exception 'TEST FAILED: status did not change back to active' using errcode = 'ZZ999';
  end if;

  select count(*) into v_deactivated_count from audit_logs where action = 'user.deactivated' and resource_id = '00000000-0000-0000-0000-000000000503';
  select count(*) into v_reactivated_count from audit_logs where action = 'user.reactivated' and resource_id = '00000000-0000-0000-0000-000000000503';
  if v_deactivated_count <> 1 or v_reactivated_count <> 1 then
    raise exception 'TEST FAILED: deactivate/reactivate were not both audit-logged' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: deactivate/reactivate work and are both audit-logged';
end $$;

reset role;
reset request.jwt.claim.sub;

-- Cross-tenant: cannot act on a profile from another business. Uses the
-- foreign Owner from section 4 (…0599, "Staff Test Shop 599") rather than
-- another file's fixture, so this test is self-contained.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000599';

do $$
begin
  begin
    perform set_staff_status('00000000-0000-0000-0000-000000000503', 'inactive');
    raise exception 'TEST FAILED: acted on another business''s staff member' using errcode = 'ZZ999';
  exception when sqlstate 'P0002' then
    raise notice 'PASS: cannot act on another business''s staff member (reported as not found)';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

\echo ''
\echo 'All staff management security tests passed.'