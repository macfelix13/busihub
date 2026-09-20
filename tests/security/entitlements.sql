-- Busihub — security/correctness tests for subscription entitlement
-- enforcement (migration 0058).
--
-- Covers:
--   1. A brand-new business's real 'trial' plan limits (max_branches: 1,
--      max_users: 5 counting the Owner, max_products: 200) are enforced
--      by the actual write paths (a direct branches insert,
--      invite_staff_member(), create_product()) — not just documented.
--   2. Once a limit is hit, moving the business to a plan with more
--      headroom (admin_set_business_subscription()) immediately lifts
--      it — same write path, same call, no special-casing.
--   3. admin_set_business_subscription() is Super-Admin-only, rejects an
--      unknown plan slug and an unknown status, and is otherwise
--      unreachable (a plain business owner gets insufficient_privilege).
--   4. process_subscription_lifecycle() drives trialing -> past_due (a
--      trial that ran out) -> expired (the grace period after that
--      running out too), and fulfils a Super-Admin-scheduled
--      cancel_at_period_end. It is reachable only as service_role — an
--      ordinary authenticated session gets insufficient_privilege.
--   5. business_subscriptions itself is still Super-Admin-only to write
--      directly (RLS, unchanged by this migration) — a business owner's
--      own direct UPDATE attempt silently matches zero rows.
--   6. admin_upsert_subscription_plan() (migration 0059) is Super-Admin-
--      only, creates and updates subscription_plans rows correctly,
--      rejects a duplicate slug/unknown billing_interval/unknown plan id,
--      and — via app_validate_plan_limits() — rejects an unrecognised
--      limits key or a negative limit value rather than silently
--      accepting a typo that would enforce nothing.
--   7. admin_upsert_subscription_plan()'s new p_paystack_plan_code
--      parameter (migration 0060) stores and updates the value given,
--      rejects the same Paystack plan being linked to two different rows,
--      and — called the old, pre-0060 way with only ten arguments — still
--      works via the parameter's default rather than erroring, confirming
--      the old 10-argument signature was actually dropped (not left
--      behind as a stale, un-synced overload — see 0060's own header).
--
-- This file runs directly after tests/security/tenant_isolation_and_rbac.sql
-- (which hardcodes an exact business count and must stay first — see its
-- own header) and BEFORE tests/db-harness/01_relax_trial_plan_for_tests.sql
-- (see that file's own header and .github/workflows/ci.yml's ordering),
-- specifically so every business created here sees the real, un-relaxed
-- 'trial' plan.
--
-- A small custom plan ('test-tiny', inserted directly below — this file
-- already writes to businesses/branches/profiles directly, same
-- privilege level) stands in for testing "near the limit, then over it"
-- without actually creating 200 products or 5 staff accounts just to
-- reach the real trial plan's numbers.
--
-- 14xx block: not used by any other tests/security/*.sql file (checked).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures: three businesses, a Super Admin, and a tiny test plan ──────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001400', 'authenticated', 'authenticated', 'entitleownera@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001401', 'authenticated', 'authenticated', 'entitlestaffa1@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001402', 'authenticated', 'authenticated', 'entitlestaffa2@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001410', 'authenticated', 'authenticated', 'entitleownerb@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001420', 'authenticated', 'authenticated', 'entitleadmin@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

-- A Super Admin profile, inserted directly here as the superuser running
-- this script — never reachable this way from the application itself
-- (same convention as tests/security/support_requests.sql).
insert into profiles (id, business_id, first_name, last_name, email, is_super_admin)
values ('00000000-0000-0000-0000-000000001420', null, 'Entitlements', 'Reviewer', 'entitleadmin@busihub.dev.example', true)
on conflict (id) do nothing;

-- Business A: exercises the REAL trial limits directly.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001400';
select register_business('Entitlements Test Shop A', 'Ama', 'Owusu');
reset role;
reset request.jwt.claim.sub;

-- Business B: only used for the "past_due -> expired" and "cancelled"
-- lifecycle transitions below.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001410';
select register_business('Entitlements Test Shop B', 'Kojo', 'Asante');
reset role;
reset request.jwt.claim.sub;

-- A plan with deliberately tiny limits, so "one more than the limit"
-- tests don't need hundreds of fixture rows. Never seen by a real
-- business — is_active is true only so admin_set_business_subscription()
-- (which requires it) can assign it in test 2 below.
insert into subscription_plans (slug, name, description, price_amount, currency_code, billing_interval, limits, is_active, sort_order)
values (
  'test-tiny', 'Test Tiny (fixture only)', 'Test-harness-only plan with tiny limits — see tests/security/entitlements.sql.',
  0, 'GHS', 'month',
  jsonb_build_object('max_users', 2, 'max_branches', 2, 'max_products', 2, 'max_pos_terminals', 1, 'storage_mb', 10,
    'features', jsonb_build_object('advanced_reports', false, 'api_access', false, 'sms_notifications', false)),
  true, 99
)
on conflict (slug) do nothing;

create table ent_ids as
select
  (select id from businesses where slug = 'entitlements-test-shop-a') as biz_a,
  (select id from businesses where slug = 'entitlements-test-shop-b') as biz_b,
  (select id from branches where business_id = (select id from businesses where slug = 'entitlements-test-shop-a') and is_main) as branch_a,
  (select id from roles where business_id = (select id from businesses where slug = 'entitlements-test-shop-a') and name = 'Cashier') as cashier_role_a,
  (select id from subscription_plans where slug = 'test-tiny') as plan_tiny,
  (select id from subscription_plans where slug = 'enterprise') as plan_enterprise;

do $$
declare r record;
begin
  select * into r from ent_ids;
  if r.biz_a is null or r.biz_b is null or r.branch_a is null or r.cashier_role_a is null or r.plan_tiny is null or r.plan_enterprise is null then
    raise exception 'TEST FIXTURE BROKEN: ent_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

grant select on ent_ids to authenticated;

-- ── 1. Real trial plan: max_branches (1) blocks a second branch ─────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001400';

do $$
declare v_biz uuid;
begin
  select biz_a into v_biz from ent_ids;
  begin
    insert into branches (business_id, name) values (v_biz, 'Shop A Second Branch');
    raise exception 'TEST FAILED: a second branch was created past the trial plan''s max_branches (1)';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: the trial plan''s max_branches (1) blocks a second branch (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 2. Super Admin moves Shop A onto the tiny test plan; branches/
-- products/staff all become possible up to ITS limits, then blocked
-- again past them ───────────────────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001420';

do $$
declare v_biz uuid; v_status subscription_status;
begin
  select biz_a into v_biz from ent_ids;
  perform admin_set_business_subscription(v_biz, 'test-tiny', 'active', now() + interval '30 days', false);
  select status into v_status from business_subscriptions where business_id = v_biz;
  if v_status <> 'active' then
    raise exception 'TEST FAILED: admin_set_business_subscription did not update status (got %)', v_status;
  end if;
  raise notice 'PASS: a Super Admin can move a business onto a different plan/status';
end $$;

-- A plain business owner cannot call this at all.
reset role;
reset request.jwt.claim.sub;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001400';

do $$
declare v_biz uuid;
begin
  select biz_a into v_biz from ent_ids;
  begin
    perform admin_set_business_subscription(v_biz, 'growth', 'active', now() + interval '30 days', false);
    raise exception 'TEST FAILED: a plain business owner was able to call admin_set_business_subscription';
  exception
    when insufficient_privilege then
      raise notice 'PASS: admin_set_business_subscription is Super-Admin-only (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- Unknown plan slug / unknown status, as the Super Admin.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001420';

do $$
declare v_biz uuid;
begin
  select biz_a into v_biz from ent_ids;
  begin
    perform admin_set_business_subscription(v_biz, 'not-a-real-plan', 'active', null, false);
    raise exception 'TEST FAILED: an unknown plan slug was accepted';
  exception
    when sqlstate 'P0002' then
      raise notice 'PASS: an unknown plan slug is rejected (%)', sqlerrm;
  end;

  begin
    perform admin_set_business_subscription(v_biz, 'test-tiny', 'not-a-real-status', null, false);
    raise exception 'TEST FAILED: an unknown status was accepted';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: an unknown subscription status is rejected (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- Now on 'test-tiny' (max_branches: 2, currently at 1) — a second branch
-- succeeds, a third does not.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001400';

do $$
declare v_biz uuid;
begin
  select biz_a into v_biz from ent_ids;
  insert into branches (business_id, name) values (v_biz, 'Shop A Second Branch');
  raise notice 'PASS: after moving to a plan with headroom, a second branch is allowed';

  begin
    insert into branches (business_id, name) values (v_biz, 'Shop A Third Branch');
    raise exception 'TEST FAILED: a third branch was created past test-tiny''s max_branches (2)';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: test-tiny''s max_branches (2) blocks a third branch (%)', sqlerrm;
  end;
end $$;

-- max_products (2 on test-tiny): first two succeed, third is blocked.
do $$
declare v_biz uuid; v_branch uuid;
begin
  select biz_a, branch_a into v_biz, v_branch from ent_ids;

  perform create_product(v_biz, 'Ent Product One', null, null, 'each', 'zero_rated', '{}'::text[],
    '[{"sku": "ENT-1", "barcode": "", "variant_options": {}, "cost_price": 1, "selling_price": 2, "opening_stock": 0}]'::jsonb,
    v_branch);
  perform create_product(v_biz, 'Ent Product Two', null, null, 'each', 'zero_rated', '{}'::text[],
    '[{"sku": "ENT-2", "barcode": "", "variant_options": {}, "cost_price": 1, "selling_price": 2, "opening_stock": 0}]'::jsonb,
    v_branch);
  raise notice 'PASS: two products created, at test-tiny''s max_products (2)';

  begin
    perform create_product(v_biz, 'Ent Product Three', null, null, 'each', 'zero_rated', '{}'::text[],
      '[{"sku": "ENT-3", "barcode": "", "variant_options": {}, "cost_price": 1, "selling_price": 2, "opening_stock": 0}]'::jsonb,
      v_branch);
    raise exception 'TEST FAILED: a third product was created past test-tiny''s max_products (2)';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: test-tiny''s max_products (2) blocks a third product (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- max_users (2 on test-tiny): the Owner already counts as 1, so exactly
-- one more invite succeeds and a second is blocked.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001400';

do $$
declare v_branch uuid; v_role uuid;
begin
  select branch_a, cashier_role_a into v_branch, v_role from ent_ids;

  perform invite_staff_member('00000000-0000-0000-0000-000000001401', v_branch, v_role, 'Ent', 'Staff One', 'entitlestaffa1@busihub.dev.example');
  raise notice 'PASS: one staff invite succeeds, reaching test-tiny''s max_users (2) with the Owner';

  begin
    perform invite_staff_member('00000000-0000-0000-0000-000000001402', v_branch, v_role, 'Ent', 'Staff Two', 'entitlestaffa2@busihub.dev.example');
    raise exception 'TEST FAILED: a second staff invite succeeded past test-tiny''s max_users (2)';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: test-tiny''s max_users (2) blocks a second staff invite (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 3. Moving to a plan with null (unlimited) limits lifts every one of
-- the above immediately ─────────────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001420';

do $$
declare v_biz uuid;
begin
  select biz_a into v_biz from ent_ids;
  perform admin_set_business_subscription(v_biz, 'enterprise', 'active', null, false);
end $$;

reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001400';

do $$
declare v_biz uuid; v_branch uuid;
begin
  select biz_a, branch_a into v_biz, v_branch from ent_ids;

  insert into branches (business_id, name) values (v_biz, 'Shop A Third Branch (unlimited now)');
  perform create_product(v_biz, 'Ent Product Three (unlimited now)', null, null, 'each', 'zero_rated', '{}'::text[],
    '[{"sku": "ENT-3B", "barcode": "", "variant_options": {}, "cost_price": 1, "selling_price": 2, "opening_stock": 0}]'::jsonb,
    v_branch);
  raise notice 'PASS: enterprise''s null (unlimited) limits lift every block above';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 4. business_subscriptions itself: still Super-Admin-only to write
-- directly — unchanged RLS, a business owner's own attempt matches zero
-- rows ───────────────────────────────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001400';

do $$
declare v_biz uuid; v_status_before subscription_status; v_status_after subscription_status;
begin
  select biz_a into v_biz from ent_ids;
  select status into v_status_before from business_subscriptions where business_id = v_biz;

  update business_subscriptions set status = 'suspended' where business_id = v_biz;

  select status into v_status_after from business_subscriptions where business_id = v_biz;
  if v_status_after <> v_status_before then
    raise exception 'TEST FAILED: a business owner was able to change their own subscription status directly (was %, now %)', v_status_before, v_status_after;
  end if;
  raise notice 'PASS: a business owner''s own direct write to business_subscriptions matches zero rows (RLS, unchanged by 0058)';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 5. process_subscription_lifecycle(): trialing -> past_due -> expired,
-- and a scheduled cancellation — reachable only as service_role ────────

-- Not reachable as an ordinary authenticated session.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001410';

do $$
begin
  begin
    perform process_subscription_lifecycle();
    raise exception 'TEST FAILED: an ordinary authenticated session was able to call process_subscription_lifecycle';
  exception
    when insufficient_privilege then
      raise notice 'PASS: process_subscription_lifecycle is service_role-only (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- Simulate Shop B's trial having already ended.
do $$
declare v_biz uuid;
begin
  select biz_b into v_biz from ent_ids;
  update business_subscriptions
    set status = 'trialing', trial_ends_at = now() - interval '1 hour', past_due_since = null
    where business_id = v_biz;
end $$;

set role service_role;

do $$
declare v_biz uuid; v_status subscription_status; v_past_due_since timestamptz; v_summary jsonb;
begin
  select biz_b into v_biz from ent_ids;
  select process_subscription_lifecycle() into v_summary;

  select status, past_due_since into v_status, v_past_due_since from business_subscriptions where business_id = v_biz;
  if v_status <> 'past_due' or v_past_due_since is null then
    raise exception 'TEST FAILED: a trial past trial_ends_at did not move to past_due (status=%, past_due_since=%)', v_status, v_past_due_since;
  end if;
  if coalesce((v_summary ->> 'trial_ended')::int, 0) < 1 then
    raise exception 'TEST FAILED: process_subscription_lifecycle summary did not count the trial ending (got %)', v_summary;
  end if;
  raise notice 'PASS: a trial past trial_ends_at moves to past_due, with past_due_since set (summary: %)', v_summary;
end $$;

-- Simulate the grace period (3 days) having elapsed too.
do $$
declare v_biz uuid;
begin
  select biz_b into v_biz from ent_ids;
  update business_subscriptions set past_due_since = now() - interval '4 days' where business_id = v_biz;
end $$;

do $$
declare v_biz uuid; v_status subscription_status;
begin
  select biz_b into v_biz from ent_ids;
  perform process_subscription_lifecycle();
  select status into v_status from business_subscriptions where business_id = v_biz;
  if v_status <> 'expired' then
    raise exception 'TEST FAILED: past_due past the grace period did not move to expired (status=%)', v_status;
  end if;
  raise notice 'PASS: past_due past the 3-day grace period moves to expired';
end $$;

reset role;

-- A Super-Admin-scheduled cancellation, once its period end arrives.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001420';

do $$
declare v_biz uuid;
begin
  select biz_b into v_biz from ent_ids;
  perform admin_set_business_subscription(v_biz, 'starter', 'active', now() - interval '1 hour', true);
end $$;

reset role;
reset request.jwt.claim.sub;

set role service_role;

do $$
declare v_biz uuid; v_status subscription_status;
begin
  select biz_b into v_biz from ent_ids;
  perform process_subscription_lifecycle();
  select status into v_status from business_subscriptions where business_id = v_biz;
  if v_status <> 'cancelled' then
    raise exception 'TEST FAILED: an active subscription with cancel_at_period_end past its current_period_end did not move to cancelled (status=%)', v_status;
  end if;
  raise notice 'PASS: cancel_at_period_end is fulfilled once current_period_end arrives';
end $$;

reset role;

-- ── 6. admin_upsert_subscription_plan() (0059): plan catalog CRUD ────────

-- Not reachable by a plain business owner.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001400';

do $$
begin
  begin
    perform admin_upsert_subscription_plan(
      null, 'ent-plan-x', 'Ent Plan X', null, 10, 'GHS', 'month',
      jsonb_build_object('max_users', 1, 'max_branches', 1, 'max_products', 1, 'max_pos_terminals', 1, 'storage_mb', 1,
        'features', jsonb_build_object('advanced_reports', false, 'api_access', false, 'sms_notifications', false)),
      true, 50
    );
    raise exception 'TEST FAILED: a plain business owner was able to call admin_upsert_subscription_plan';
  exception
    when insufficient_privilege then
      raise notice 'PASS: admin_upsert_subscription_plan is Super-Admin-only (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001420';

-- A Super Admin can create a new plan; it lands with exactly the fields given.
do $$
declare v_id uuid; v_row subscription_plans%rowtype;
begin
  v_id := admin_upsert_subscription_plan(
    null, 'Ent-Plan-New', 'Ent Plan New', '  a test plan  ', 199.99, 'ghs', 'month',
    jsonb_build_object('max_users', 4, 'max_branches', null, 'max_products', 10, 'max_pos_terminals', 1, 'storage_mb', 100,
      'features', jsonb_build_object('advanced_reports', true, 'api_access', false, 'sms_notifications', false)),
    true, 50
  );
  select * into v_row from subscription_plans where id = v_id;
  if v_row.slug <> 'ent-plan-new' or v_row.name <> 'Ent Plan New' or v_row.description <> 'a test plan'
     or v_row.price_amount <> 199.99 or v_row.currency_code <> 'GHS' or v_row.limits ->> 'max_branches' is not null
     or (v_row.limits ->> 'max_users')::int <> 4 then
    raise exception 'TEST FAILED: created plan does not match what was given (%)', to_jsonb(v_row);
  end if;
  raise notice 'PASS: a Super Admin can create a new plan (slug lowercased, description trimmed, limits stored as given)';
end $$;

-- Duplicate slug is rejected.
do $$
begin
  begin
    perform admin_upsert_subscription_plan(
      null, 'ent-plan-new', 'Ent Plan Dup', null, 0, 'GHS', 'month', jsonb_build_object(), true, 0
    );
    raise exception 'TEST FAILED: a duplicate plan slug was accepted';
  exception
    when sqlstate '23505' then
      raise notice 'PASS: a duplicate plan slug is rejected (%)', sqlerrm;
  end;
end $$;

-- An unknown billing_interval is rejected.
do $$
begin
  begin
    perform admin_upsert_subscription_plan(
      null, 'ent-plan-bad-interval', 'Bad Interval', null, 0, 'GHS', 'fortnight', jsonb_build_object(), true, 0
    );
    raise exception 'TEST FAILED: an unknown billing_interval was accepted';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: an unknown billing_interval is rejected (%)', sqlerrm;
  end;
end $$;

-- A typo'd limits key is rejected, rather than silently doing nothing.
do $$
begin
  begin
    perform admin_upsert_subscription_plan(
      null, 'ent-plan-bad-limit-key', 'Bad Limit Key', null, 0, 'GHS', 'month',
      jsonb_build_object('max_branch', 1), true, 0
    );
    raise exception 'TEST FAILED: an unrecognised limits key (max_branch) was accepted';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: an unrecognised limits key is rejected (%)', sqlerrm;
  end;
end $$;

-- A negative limit value is rejected.
do $$
begin
  begin
    perform admin_upsert_subscription_plan(
      null, 'ent-plan-negative-limit', 'Negative Limit', null, 0, 'GHS', 'month',
      jsonb_build_object('max_branches', -1), true, 0
    );
    raise exception 'TEST FAILED: a negative limit value was accepted';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: a negative limit value is rejected (%)', sqlerrm;
  end;
end $$;

-- Updating an existing plan by id changes it in place (same id, new price).
do $$
declare v_id uuid; v_returned_id uuid; v_price numeric;
begin
  select id into v_id from subscription_plans where slug = 'ent-plan-new';
  v_returned_id := admin_upsert_subscription_plan(
    v_id, 'ent-plan-new', 'Ent Plan New (renamed)', null, 249.50, 'GHS', 'month',
    jsonb_build_object('max_users', 4, 'max_branches', null, 'max_products', 10, 'max_pos_terminals', 1, 'storage_mb', 100,
      'features', jsonb_build_object('advanced_reports', true, 'api_access', false, 'sms_notifications', false)),
    true, 50
  );
  select price_amount into v_price from subscription_plans where id = v_id;
  if v_returned_id <> v_id or v_price <> 249.50 then
    raise exception 'TEST FAILED: updating an existing plan by id did not take effect (returned id %, price %)', v_returned_id, v_price;
  end if;
  raise notice 'PASS: updating an existing plan by id changes it in place';
end $$;

-- An unknown plan id on an update is rejected, not silently a no-op.
do $$
begin
  begin
    perform admin_upsert_subscription_plan(
      '00000000-0000-0000-0000-000000009999', 'ent-plan-ghost', 'Ghost Plan', null, 0, 'GHS', 'month', jsonb_build_object(), true, 0
    );
    raise exception 'TEST FAILED: an update with an unknown plan id was accepted';
  exception
    when sqlstate 'P0002' then
      raise notice 'PASS: an update with an unknown plan id is rejected (%)', sqlerrm;
  end;
end $$;

-- ── 7. admin_upsert_subscription_plan(): paystack_plan_code (0060) ───────

-- Creating a plan with a Paystack plan code stores it.
do $$
declare v_id uuid; v_code text;
begin
  v_id := admin_upsert_subscription_plan(
    null, 'ent-plan-paystack-a', 'Ent Plan Paystack A', null, 50, 'GHS', 'month', jsonb_build_object(), true, 0,
    'PLN_ent_test_a'
  );
  select paystack_plan_code into v_code from subscription_plans where id = v_id;
  if v_code <> 'PLN_ent_test_a' then
    raise exception 'TEST FAILED: paystack_plan_code was not stored on create (got %)', v_code;
  end if;
  raise notice 'PASS: creating a plan with a Paystack plan code stores it';
end $$;

-- Updating a plan can change its Paystack plan code.
do $$
declare v_id uuid; v_code text;
begin
  select id into v_id from subscription_plans where slug = 'ent-plan-paystack-a';
  perform admin_upsert_subscription_plan(
    v_id, 'ent-plan-paystack-a', 'Ent Plan Paystack A', null, 50, 'GHS', 'month', jsonb_build_object(), true, 0,
    'PLN_ent_test_a_v2'
  );
  select paystack_plan_code into v_code from subscription_plans where id = v_id;
  if v_code <> 'PLN_ent_test_a_v2' then
    raise exception 'TEST FAILED: paystack_plan_code was not updated (got %)', v_code;
  end if;
  raise notice 'PASS: updating a plan can change its Paystack plan code';
end $$;

-- The same Paystack plan code cannot be linked to two different plans —
-- a real occurrence would mean something went wrong during sync, not a
-- legitimate state, so it is rejected rather than silently duplicated.
do $$
begin
  begin
    perform admin_upsert_subscription_plan(
      null, 'ent-plan-paystack-b', 'Ent Plan Paystack B', null, 75, 'GHS', 'month', jsonb_build_object(), true, 0,
      'PLN_ent_test_a_v2'
    );
    raise exception 'TEST FAILED: a duplicate paystack_plan_code across two plans was accepted';
  exception
    when sqlstate '23505' then
      raise notice 'PASS: a duplicate paystack_plan_code across two plans is rejected (%)', sqlerrm;
  end;
end $$;

-- Called the old, pre-0060 way (ten arguments, the exact signature 0059
-- shipped) still works — the default is what makes this possible, and
-- it proves the old 10-argument function was actually dropped rather
-- than left behind as a separate, stale overload: if it had been left
-- behind, THIS call would hit that old copy and paystack_plan_code would
-- never even be a column it knows about, while the row's existing
-- 'PLN_ent_test_a_v2' would be untouched — instead, calling through the
-- new function with the parameter omitted explicitly nulls it, which is
-- what proves the call actually landed on the new, 11-parameter function.
do $$
declare v_id uuid; v_code text;
begin
  select id into v_id from subscription_plans where slug = 'ent-plan-paystack-a';
  perform admin_upsert_subscription_plan(
    v_id, 'ent-plan-paystack-a', 'Ent Plan Paystack A (old call shape)', null, 50, 'GHS', 'month', jsonb_build_object(), true, 0
  );
  select paystack_plan_code into v_code from subscription_plans where id = v_id;
  if v_code is not null then
    raise exception 'TEST FAILED: a 10-argument call did not land on the new function (paystack_plan_code is still %)', v_code;
  end if;
  raise notice 'PASS: the old 10-argument call shape still works, via the new parameter''s default';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── cleanup ────────────────────────────────────────────────────────────

drop table ent_ids;

do $$ begin raise notice 'All entitlements (0058/0059/0060) tests passed.'; end $$;