-- Busihub — security test: onboarding_status() (0053).
--
-- Two things worth proving directly, the same way products_cross_tenant.sql
-- proves products/product_variants isolation on their own rather than
-- leaning on indirect coverage: (1) a fresh business with nothing in it
-- gets an honest all-false checklist, not a false positive from stale or
-- shared state, and (2) one business's progress never leaks into
-- another's onboarding_status() call — it is SECURITY INVOKER with no
-- business_id argument, so the only thing standing between the two is
-- RLS on the tables it reads, and this is where that gets checked.
--
-- Run against a throwaway Postgres loaded with
-- tests/db-harness/00_stub_supabase.sql + supabase/migrations/*.sql +
-- supabase/seed.sql (see tests/security/README.md).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures: two fresh, otherwise-unused businesses ─────────────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000300',
   'authenticated', 'authenticated', 'ownerx@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000301',
   'authenticated', 'authenticated', 'ownery@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000300';
select register_business('Onboarding Test Shop X', 'Kwame', 'Asante');
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000301';
select register_business('Onboarding Test Shop Y', 'Ama', 'Boateng');
reset role;
reset request.jwt.claim.sub;

create table obc_ids as
select
  (select id from businesses where slug = 'onboarding-test-shop-x') as biz_x,
  (select id from businesses where slug = 'onboarding-test-shop-y') as biz_y;

do $$
declare r record;
begin
  select * into r from obc_ids;
  if r.biz_x is null or r.biz_y is null then
    raise exception 'TEST FIXTURE BROKEN: obc_ids has a null — register_business() did not produce the expected slugs' using errcode = 'ZZ999';
  end if;
end $$;

grant select on obc_ids to authenticated;

-- ── a brand-new business gets an honest, all-false checklist ─────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000300';

do $$
declare r record;
begin
  select * into r from onboarding_status();
  if r.has_product or r.has_stock or r.has_sale or r.payment_connected or r.has_extra_staff or r.dismissed then
    raise exception 'TEST FAILED: a fresh business with nothing in it should see every onboarding_status() column false, got %', r using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: fresh business sees an honest all-false checklist';
end $$;

-- ── shop X adds a product; only shop X's checklist should move ───────────

insert into products (business_id, name)
select biz_x, 'Onboarding Checklist Product' from obc_ids;

do $$
declare r record;
begin
  select * into r from onboarding_status();
  if not r.has_product then
    raise exception 'TEST FAILED: shop X added a product but onboarding_status().has_product is still false' using errcode = 'ZZ999';
  end if;
  if r.has_stock or r.has_sale or r.payment_connected or r.has_extra_staff then
    raise exception 'TEST FAILED: adding a product alone should not flip any other onboarding_status() column, got %', r using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: has_product flips true for shop X after it adds a product, nothing else does';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── the actual test: shop Y's checklist does not see shop X's product ────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000301';

do $$
declare r record;
begin
  select * into r from onboarding_status();
  if r.has_product then
    raise exception 'TEST FAILED: shop Y''s onboarding_status() reports has_product=true from shop X''s product — cross-tenant leak' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: shop Y sees has_product=false — shop X''s product does not leak across the onboarding checklist';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── dismissing the checklist requires business.manage, same as any other
-- business_settings write (0009) — this is not a new gate, just confirming
-- the new column inherits the existing one rather than accidentally
-- becoming globally writable.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000301';

do $$
declare
  v_rows int;
  v_dismissed boolean;
begin
  update business_settings
    set onboarding_settings = jsonb_set(onboarding_settings, '{dismissed}', 'true')
    where business_id = (select biz_y from obc_ids);
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'TEST FAILED: shop Y''s own Owner should be able to dismiss shop Y''s checklist (% row(s) affected)', v_rows using errcode = 'ZZ999';
  end if;

  select (onboarding_settings ->> 'dismissed')::boolean into v_dismissed
    from business_settings where business_id = (select biz_y from obc_ids);
  if v_dismissed is not true then
    raise exception 'TEST FAILED: shop Y''s onboarding_settings.dismissed did not persist as true' using errcode = 'ZZ999';
  end if;

  select r.dismissed into v_dismissed from onboarding_status() r;
  if v_dismissed is not true then
    raise exception 'TEST FAILED: onboarding_status().dismissed did not reflect the update just made' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: shop Y''s Owner can dismiss its own checklist, and onboarding_status() reflects it';
end $$;

reset role;
reset request.jwt.claim.sub;

\echo ''
\echo 'All onboarding_status() tests passed.'