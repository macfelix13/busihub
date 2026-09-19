-- Busihub — test-harness only: relax the 'trial' plan's limits after
-- 0058's entitlement enforcement landed.
--
-- Every one of this repo's ~25 security test files creates its own
-- businesses via register_business() (or, for the dev seed, follows the
-- same steps by hand — see supabase/seed.sql), which puts each one on
-- the real 'trial' plan (see 0010's seed data: max_branches 1,
-- max_products 200, max_users 5). Those exact numbers are exercised
-- deliberately by tests/security/entitlements.sql — which is why this
-- file is applied AFTER that one and never before it (see
-- .github/workflows/ci.yml's ordering).
--
-- Every OTHER security test file was written, long before Phase 18
-- existed, to exercise RBAC/RLS/business-logic correctness, not plan
-- limits — several of them create more branches/products/staff on a
-- shared fixture business than the real trial plan allows (e.g.
-- tests/security/dashboard.sql's second branch, or the cumulative staff
-- count on 'busihub-demo-store' across the whole suite) simply because
-- that was never a constraint when they were written. Patching every one
-- of those files individually to first upgrade its own fixture
-- business's plan would scatter a single, new concern (this repo's test
-- businesses need generous limits) across two dozen unrelated files that
-- have nothing to do with billing. Loosening the 'trial' plan itself,
-- once, here, keeps that concern in one place instead.
--
-- Test-database only, exactly like 00_stub_supabase.sql (see that file's
-- own header) — never applied to a real Supabase project, and NOT run by
-- `npm run db:seed` locally: a developer testing Phase 18 itself against
-- their own local/dev Supabase project should see the real trial limits
-- on the seeded demo business, exactly as a real trial business would.

update subscription_plans
  set limits = jsonb_build_object(
    'max_users', null,
    'max_branches', null,
    'max_products', null,
    'max_pos_terminals', null,
    'storage_mb', null,
    'features', jsonb_build_object('advanced_reports', true, 'api_access', true, 'sms_notifications', true)
  )
  where slug = 'trial';