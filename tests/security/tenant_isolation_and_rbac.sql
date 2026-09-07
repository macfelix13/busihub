-- Busihub — security test: tenant isolation, RBAC enforcement, and
-- privilege-escalation resistance, exercised directly against Postgres +
-- RLS (not through the application layer) so a bug in application code
-- can never be the reason these guarantees hold.
--
-- Run locally or in CI against a throwaway Postgres loaded with
-- tests/db-harness/00_stub_supabase.sql + supabase/migrations/*.sql +
-- supabase/seed.sql (see tests/security/README.md / .github/workflows/ci.yml).
--
-- Any `TEST FAILED` notice/exception aborts the script (ON_ERROR_STOP) —
-- CI treats a non-zero psql exit code as a failed build.

\set ON_ERROR_STOP on
\pset format aligned

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000002',
        'authenticated', 'authenticated', 'owner2@busihub.dev.example', 'x', now());

-- ── register_business() works end-to-end as a real authenticated session ──
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000002';
select register_business('Second Shop Ltd', 'Ama', 'Mensah');
reset role;
reset request.jwt.claim.sub;

do $$
begin
  if (select count(*) from businesses) <> 2 then
    raise exception 'TEST FAILED: expected exactly 2 businesses after seed + register_business()';
  end if;
end $$;

-- ── sales.no_sale (migration 0044): catalogued and correctly granted ─────
-- Both businesses below have their Owner/Manager roles seeded by calling
-- seed_default_roles_for_business() (the demo store directly from
-- supabase/seed.sql, "Second Shop Ltd" via register_business() just
-- above) — and by the time either runs in THIS test's execution order,
-- migration 0044 has already redefined that function. So both checks
-- below prove the UPDATED function grants sales.no_sale correctly; on
-- their own they say nothing about whether 0044's separate backfill
-- statement (for a business that already existed when 0044 first ran in
-- a real, already-running deployment) actually works — that only shows
-- up once a business's rows predate the migration, which no fixture here
-- does by construction. The next block manufactures exactly that
-- situation and exercises the backfill statement itself, rather than
-- only ever checking a state the updated function alone could produce.
do $$
declare
  v_permission_id uuid;
  v_demo_business_id uuid;
  v_second_business_id uuid;
begin
  select id into v_permission_id from permissions where key = 'sales.no_sale';
  if v_permission_id is null then
    raise exception 'TEST FAILED: sales.no_sale is missing from the permissions catalog';
  end if;
  if (select category from permissions where id = v_permission_id) <> 'sales' then
    raise exception 'TEST FAILED: sales.no_sale should be catalogued under the sales category';
  end if;

  select id into v_demo_business_id from businesses where slug = 'busihub-demo-store';
  select id into v_second_business_id from businesses where slug = 'second-shop-ltd';

  if not exists (
    select 1 from role_permissions rp
    join roles r on r.id = rp.role_id
    where r.business_id = v_demo_business_id and r.name = 'Owner' and rp.permission_id = v_permission_id
  ) then
    raise exception 'TEST FAILED: the demo business Owner role does not hold sales.no_sale';
  end if;
  if not exists (
    select 1 from role_permissions rp
    join roles r on r.id = rp.role_id
    where r.business_id = v_demo_business_id and r.name = 'Manager' and rp.permission_id = v_permission_id
  ) then
    raise exception 'TEST FAILED: the demo business Manager role does not hold sales.no_sale';
  end if;

  if not exists (
    select 1 from role_permissions rp
    join roles r on r.id = rp.role_id
    where r.business_id = v_second_business_id and r.name = 'Owner' and rp.permission_id = v_permission_id
  ) then
    raise exception 'TEST FAILED: a freshly registered business''s Owner role does not hold sales.no_sale';
  end if;
  if not exists (
    select 1 from role_permissions rp
    join roles r on r.id = rp.role_id
    where r.business_id = v_second_business_id and r.name = 'Manager' and rp.permission_id = v_permission_id
  ) then
    raise exception 'TEST FAILED: a freshly registered business''s Manager role does not hold sales.no_sale';
  end if;

  raise notice 'PASS: the updated seed_default_roles_for_business() grants sales.no_sale to Owner and Manager, both via a direct call (demo store) and via register_business() (Second Shop Ltd)';
end $$;

-- ── sales.no_sale (migration 0044): the BACKFILL statement itself ────────
-- Manufactures the one situation the checks above cannot: a business
-- whose role_permissions rows predate 0044. Removes the demo business
-- Owner's just-granted row, then runs the exact statement
-- 0044_till_no_sale.sql runs, and confirms it restores the grant — this
-- is what actually proves the backfill (not just the updated seed
-- function) does its job, since every fixture in this file was in fact
-- created after 0044 had already been applied.
do $$
declare
  v_permission_id uuid;
  v_demo_owner_role uuid;
begin
  select id into v_permission_id from permissions where key = 'sales.no_sale';
  select r.id into v_demo_owner_role
    from roles r
    where r.business_id = (select id from businesses where slug = 'busihub-demo-store') and r.name = 'Owner';

  delete from role_permissions where role_id = v_demo_owner_role and permission_id = v_permission_id;

  if exists (select 1 from role_permissions where role_id = v_demo_owner_role and permission_id = v_permission_id) then
    raise exception 'TEST FAILED: could not remove the grant to simulate a pre-0044 business — the backfill statement below would not actually be exercised';
  end if;

  -- The exact statement from 0044_till_no_sale.sql.
  insert into role_permissions (role_id, permission_id)
  select r.id, p.id
  from roles r
  cross join permissions p
  where r.is_system_role and r.name in ('Owner', 'Manager') and p.key = 'sales.no_sale'
  on conflict (role_id, permission_id) do nothing;

  if not exists (select 1 from role_permissions where role_id = v_demo_owner_role and permission_id = v_permission_id) then
    raise exception 'TEST FAILED: 0044''s backfill statement did not restore sales.no_sale to a role simulated as missing it';
  end if;

  raise notice 'PASS: 0044''s backfill statement correctly restores sales.no_sale to a role that was missing it, proving the migration would have worked against an already-running deployment';
end $$;

-- ── Tenant isolation: business A's owner cannot see business B's rows ─────
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare
  v_visible_businesses int;
  v_visible_branches int;
  v_cross_tenant_hits int;
begin
  select count(*) into v_visible_businesses from businesses;
  select count(*) into v_visible_branches from branches;
  select count(*) into v_cross_tenant_hits from businesses where slug = 'second-shop-ltd';

  if v_visible_businesses <> 1 then
    raise exception 'TEST FAILED: business A owner should see exactly 1 business, saw %', v_visible_businesses;
  end if;
  if v_visible_branches <> 1 then
    raise exception 'TEST FAILED: business A owner should see exactly 1 branch, saw %', v_visible_branches;
  end if;
  if v_cross_tenant_hits <> 0 then
    raise exception 'TEST FAILED: business A owner could read business B by slug';
  end if;

  raise notice 'PASS: tenant isolation (businesses, branches)';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── Set up a Cashier user on business A for permission tests ──────────────
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000099',
        'authenticated', 'authenticated', 'cashier@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

do $$
declare
  v_business_id uuid;
  v_branch_id uuid;
  v_cashier_role_id uuid;
begin
  select id into v_business_id from businesses where slug = 'busihub-demo-store';
  select id into v_branch_id from branches where business_id = v_business_id and is_main;
  select id into v_cashier_role_id from roles where business_id = v_business_id and name = 'Cashier';

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000099', v_business_id, 'Demo', 'Cashier', 'cashier@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_business_id, v_branch_id, '00000000-0000-0000-0000-000000000099', v_cashier_role_id, '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;
end $$;

-- ── RBAC: cashier cannot perform a manager/owner-only write ───────────────
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000099';

do $$
declare
  v_business_id uuid;
begin
  select id into v_business_id from businesses where slug = 'busihub-demo-store';

  begin
    insert into roles (business_id, name, description) values (v_business_id, 'Rogue Role', 'should fail');
    raise exception 'TEST FAILED: cashier was able to create a role (requires roles.manage)';
  exception
    when sqlstate '42501' then raise notice 'PASS: cashier blocked from roles.manage action';
    when others then
      if sqlerrm like 'TEST FAILED%' then raise; end if;
      raise notice 'PASS: cashier blocked from roles.manage action (%)', sqlerrm;
  end;

  if not app_has_permission(v_business_id, 'sales.process') then
    raise exception 'TEST FAILED: cashier should hold sales.process';
  end if;
  if app_has_permission(v_business_id, 'roles.manage') then
    raise exception 'TEST FAILED: cashier should NOT hold roles.manage';
  end if;
  if app_has_permission(v_business_id, 'sales.no_sale') then
    raise exception 'TEST FAILED: cashier should NOT hold sales.no_sale by default (migration 0044) — it is meant to be granted deliberately, not handed to every cashier automatically';
  end if;

  raise notice 'PASS: permission resolution correct for Cashier role';
end $$;

-- ── Privilege escalation: cashier cannot self-promote or move tenants ────
do $$
begin
  begin
    update profiles set is_super_admin = true where id = '00000000-0000-0000-0000-000000000099';
    raise exception 'TEST FAILED: cashier escalated themself to super admin';
  exception
    when others then
      if sqlerrm like 'TEST FAILED%' then raise; end if;
      raise notice 'PASS: blocked is_super_admin self-escalation';
  end;

  begin
    update profiles set business_id = (select id from businesses where slug = 'second-shop-ltd')
      where id = '00000000-0000-0000-0000-000000000099';
    raise exception 'TEST FAILED: cashier moved themself to another business';
  exception
    when others then
      if sqlerrm like 'TEST FAILED%' then raise; end if;
      raise notice 'PASS: blocked business_id tampering';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── anon: no tenant data, but the public plan catalog is readable ────────
set role anon;

do $$
declare
  v_visible_businesses int;
  v_plan_count int;
begin
  select count(*) into v_visible_businesses from businesses;
  select count(*) into v_plan_count from subscription_plans;

  if v_visible_businesses <> 0 then
    raise exception 'TEST FAILED: anonymous role should see 0 businesses, saw %', v_visible_businesses;
  end if;
  if v_plan_count = 0 then
    raise exception 'TEST FAILED: anonymous role should be able to read the public subscription plan catalog';
  end if;

  raise notice 'PASS: anon isolation + public plan catalog readable';
end $$;

reset role;

\echo 'ALL SECURITY TESTS PASSED'