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
