-- Busihub — security tests for custom staff roles (migration 0054).
--
-- Covers set_role_permissions() (the new SECURITY DEFINER function) and
-- the two new guardrail triggers, protect_system_role_identity() and
-- prevent_assigned_role_delete() — all exercised as real authenticated
-- Postgres sessions, not through the application layer, same approach as
-- tenant_isolation_and_rbac.sql and staff_management.sql:
--   1. A caller without roles.manage cannot call set_role_permissions.
--   2. A role id from another business is rejected as not found, not
--      silently applied cross-tenant.
--   3. An Owner can create a custom role and set_role_permissions()
--      REPLACES its permission set on each call rather than appending.
--   4. The built-in Owner role can't be renamed.
--   5. The built-in Owner role can't be stripped of roles.manage /
--      business.manage, and a rejected call makes no partial change.
--   6. A role currently assigned to a staff member can't be deleted;
--      once unassigned, deletion succeeds.
--   7. A built-in role still can't be deleted at all (pre-existing RLS,
--      confirmed unchanged by this migration's new trigger).
--
-- Run against a throwaway Postgres loaded with
-- tests/db-harness/00_stub_supabase.sql + supabase/migrations/*.sql +
-- supabase/seed.sql (+ every earlier tests/security/*.sql file, per
-- .github/workflows/ci.yml's run order).
--
-- 10xx block: not used by any other tests/security/*.sql file (checked).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures: two fresh businesses ────────────────────────────────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001000', 'authenticated', 'authenticated', 'rolesownerx@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001001', 'authenticated', 'authenticated', 'rolesownery@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001002', 'authenticated', 'authenticated', 'rolescashierx@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001003', 'authenticated', 'authenticated', 'rolesassignedx@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001000';
select register_business('Custom Roles Test Shop X', 'Kofi', 'Mensah');
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001001';
select register_business('Custom Roles Test Shop Y', 'Efua', 'Owusu');
reset role;
reset request.jwt.claim.sub;

create table cr_ids as
select
  (select id from businesses where slug = 'custom-roles-test-shop-x') as biz_x,
  (select id from businesses where slug = 'custom-roles-test-shop-y') as biz_y,
  (select id from branches where business_id = (select id from businesses where slug = 'custom-roles-test-shop-x') and is_main) as branch_x,
  (select id from roles where business_id = (select id from businesses where slug = 'custom-roles-test-shop-x') and name = 'Owner') as owner_role_x,
  (select id from roles where business_id = (select id from businesses where slug = 'custom-roles-test-shop-x') and name = 'Cashier') as cashier_role_x;

do $$
declare r record;
begin
  select * into r from cr_ids;
  if r.biz_x is null or r.biz_y is null or r.branch_x is null or r.owner_role_x is null or r.cashier_role_x is null then
    raise exception 'TEST FIXTURE BROKEN: cr_ids has a null — register_business() did not produce the expected rows' using errcode = 'ZZ999';
  end if;
end $$;

grant select on cr_ids to authenticated;

-- Bootstrap a Cashier in shop X directly (not via invite), same pattern
-- staff_management.sql already uses, so this test doesn't depend on the
-- invite flow.
do $$
declare v_biz uuid; v_branch uuid; v_role uuid;
begin
  select biz_x, branch_x, cashier_role_x into v_biz, v_branch, v_role from cr_ids;

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000001002', v_biz, 'Fixture', 'Cashier', 'rolescashierx@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000001002', v_role, '00000000-0000-0000-0000-000000001000')
    on conflict do nothing;
end $$;

-- ── 1. A Cashier (no roles.manage) cannot call set_role_permissions ──────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001002';

do $$
declare v_owner_role uuid;
begin
  select owner_role_x into v_owner_role from cr_ids;
  begin
    perform set_role_permissions(v_owner_role, array['products.view']);
    raise exception 'TEST FAILED: a Cashier without roles.manage was able to call set_role_permissions';
  exception
    when insufficient_privilege then
      raise notice 'PASS: a Cashier without roles.manage cannot call set_role_permissions (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 2. Cross-tenant: shop Y's Owner cannot touch shop X's role ──────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001001';

do $$
declare v_role_x uuid;
begin
  select owner_role_x into v_role_x from cr_ids;
  begin
    perform set_role_permissions(v_role_x, array['products.view']);
    raise exception 'TEST FAILED: shop Y''s Owner was able to modify a role belonging to shop X';
  exception
    when sqlstate 'P0002' then
      raise notice 'PASS: a role id from another business is rejected as not found, not silently applied cross-tenant (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 3. Owner creates a custom role; set_role_permissions() REPLACES, not
-- appends ──────────────────────────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001000';

do $$
declare v_biz uuid; v_role_id uuid; v_perm_count int;
begin
  select biz_x into v_biz from cr_ids;

  insert into roles (business_id, name, is_system_role) values (v_biz, 'Stock Clerk', false) returning id into v_role_id;

  perform set_role_permissions(v_role_id, array['inventory.view', 'inventory.receive']);

  select count(*) into v_perm_count from role_permissions where role_id = v_role_id;
  if v_perm_count <> 2 then
    raise exception 'TEST FAILED: expected exactly 2 permissions on the new custom role, got %', v_perm_count using errcode = 'ZZ999';
  end if;

  perform set_role_permissions(v_role_id, array['inventory.view']);

  select count(*) into v_perm_count from role_permissions where role_id = v_role_id;
  if v_perm_count <> 1 then
    raise exception 'TEST FAILED: set_role_permissions should replace the permission set, not append to it (got % rows)', v_perm_count using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: an Owner can create a custom role, and set_role_permissions() replaces its permission set on each call';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 4. The built-in Owner role can't be renamed ──────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001000';

do $$
declare v_role_id uuid;
begin
  select owner_role_x into v_role_id from cr_ids;
  begin
    update roles set name = 'Big Boss' where id = v_role_id;
    raise exception 'TEST FAILED: the built-in Owner role was renamed';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: protect_system_role_identity blocks renaming the built-in Owner role (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 5. The Owner role can't be stripped of roles.manage / business.manage,
-- and a rejected call leaves its permissions untouched ───────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001000';

do $$
declare v_role_id uuid;
begin
  select owner_role_x into v_role_id from cr_ids;
  begin
    perform set_role_permissions(v_role_id, array['products.view']);
    raise exception 'TEST FAILED: the Owner role was stripped of roles.manage/business.manage';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: set_role_permissions refuses to strip the Owner role of roles.manage/business.manage (%)', sqlerrm;
  end;
end $$;

do $$
declare v_role_id uuid; v_count int;
begin
  select owner_role_x into v_role_id from cr_ids;
  select count(*) into v_count from role_permissions where role_id = v_role_id;
  -- seed_default_roles_for_business() (0011) grants the Owner role every
  -- permission in the catalog — comfortably more than 2 if untouched.
  if v_count < 2 then
    raise exception 'TEST FAILED: the rejected set_role_permissions call left the Owner role with too few permissions (%)', v_count using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a rejected set_role_permissions call makes no partial change (Owner still has % permissions)', v_count;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 6. A role currently assigned to a staff member can't be deleted;
-- once unassigned, deletion succeeds ──────────────────────────────────────

-- profiles has no insert RLS policy at all (rows are created server-side
-- by a service-role client — see 0009's own comment on the table) — this
-- fixture insert runs as the unrestricted postgres role, same as the
-- Cashier bootstrap above, not as 'authenticated'.
do $$
declare v_biz uuid; v_branch uuid; v_role_id uuid;
begin
  select biz_x, branch_x into v_biz, v_branch from cr_ids;
  select id into v_role_id from roles where business_id = v_biz and name = 'Stock Clerk';

  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000001003', v_biz, 'Fixture', 'StockClerk', 'rolesassignedx@busihub.dev.example')
    on conflict (id) do nothing;

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000001003', v_role_id, '00000000-0000-0000-0000-000000001000')
    on conflict do nothing;
end $$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001000';

do $$
declare v_biz uuid; v_role_id uuid;
begin
  select biz_x into v_biz from cr_ids;
  select id into v_role_id from roles where business_id = v_biz and name = 'Stock Clerk';

  begin
    delete from roles where id = v_role_id;
    raise exception 'TEST FAILED: a role assigned to an active staff member was deleted';
  exception
    when foreign_key_violation then
      raise notice 'PASS: prevent_assigned_role_delete blocks deleting a role currently assigned to staff (%)', sqlerrm;
  end;
end $$;

do $$
declare v_biz uuid; v_role_id uuid; v_count int;
begin
  select biz_x into v_biz from cr_ids;
  select id into v_role_id from roles where business_id = v_biz and name = 'Stock Clerk';

  delete from user_branch_roles where role_id = v_role_id;
  delete from roles where id = v_role_id;

  select count(*) into v_count from roles where id = v_role_id;
  if v_count <> 0 then
    raise exception 'TEST FAILED: deleting an unassigned custom role should succeed' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: once unassigned, a custom role can be deleted';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 7. A built-in role still can't be deleted at all (pre-existing RLS,
-- unchanged by this migration's new trigger) ──────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001000';

do $$
declare v_role_id uuid; v_rows int;
begin
  select cashier_role_x into v_role_id from cr_ids;
  delete from roles where id = v_role_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'TEST FAILED: the built-in Cashier role was deleted (roles_delete RLS should block it)' using errcode = 'ZZ999';
  end if;
  if not exists (select 1 from roles where id = v_role_id) then
    raise exception 'TEST FAILED: the built-in Cashier role no longer exists' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a built-in role still cannot be deleted (roles_delete RLS policy, unchanged by 0054)';
end $$;

reset role;
reset request.jwt.claim.sub;

\echo ''
\echo 'All custom-roles (0054) tests passed.'