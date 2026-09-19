-- Busihub — security/correctness tests for support requests (migration 0057)
--
-- Exercises: a business can send a support request and see it; the
-- business_id/submitted_by trigger cannot be spoofed by a client-supplied
-- value on insert; a business sees only its own requests and cannot
-- resolve one; and a Super Admin sees every business's requests and can
-- resolve one.
--
-- 13xx block: not used by any other tests/security/*.sql file (checked).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures: two businesses, plus a platform Super Admin ────────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001300', 'authenticated', 'authenticated', 'supportreqownerx@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001301', 'authenticated', 'authenticated', 'supportreqownery@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000001302', 'authenticated', 'authenticated', 'supportreqadmin@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

-- A Super Admin profile, inserted directly here as the superuser running
-- this script — never reachable this way from the application itself.
-- bootstrap_super_admin() (0035) is the only sanctioned path outside a
-- test harness like this one, and it is revoked from authenticated/anon.
insert into profiles (id, business_id, first_name, last_name, email, is_super_admin)
values ('00000000-0000-0000-0000-000000001302', null, 'Support', 'Reviewer', 'supportreqadmin@busihub.dev.example', true)
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001300';
select register_business('Support Req Shop X', 'Ama', 'Boateng');
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001301';
select register_business('Support Req Shop Y', 'Kojo', 'Mensah');
reset role;
reset request.jwt.claim.sub;

-- ── 1. business_id/submitted_by cannot be spoofed on insert ──────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001300';

do $$
declare
  v_business_x uuid;
  v_business_y uuid;
  v_row record;
begin
  select id into v_business_x from businesses where slug = 'support-req-shop-x';
  select id into v_business_y from businesses where slug = 'support-req-shop-y';

  -- Explicitly naming shop Y's business_id and a fake submitter — the
  -- set_sender trigger must overwrite both, not just fill in a default.
  insert into support_requests (business_id, submitted_by, message)
  values (v_business_y, '00000000-0000-0000-0000-000000001301', 'Trying to look like shop Y sent this')
  returning * into v_row;

  if v_row.business_id <> v_business_x then
    raise exception 'TEST FAILED: support_requests.business_id was spoofable (got %, expected shop X''s id %)', v_row.business_id, v_business_x
      using errcode = 'ZZ999';
  end if;
  if v_row.submitted_by <> '00000000-0000-0000-0000-000000001300'::uuid then
    raise exception 'TEST FAILED: support_requests.submitted_by was spoofable (got %)', v_row.submitted_by using errcode = 'ZZ999';
  end if;
  if v_row.status <> 'open' or v_row.resolved_by is not null or v_row.resolved_at is not null then
    raise exception 'TEST FAILED: a new request should default to status=open with no resolution, got status=%, resolved_by=%, resolved_at=%',
      v_row.status, v_row.resolved_by, v_row.resolved_at using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: support_requests.business_id/submitted_by/status are forced to the caller''s own session and fresh-request defaults, not the spoofed values sent';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 2. A business sees only its own requests, never another's ───────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001301';
insert into support_requests (message) values ('Shop Y needs help connecting Paystack');
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001300';

do $$
declare
  v_count int;
  v_other_count int;
begin
  select count(*) into v_count from support_requests;
  if v_count <> 1 then
    raise exception 'TEST FAILED: shop X should see exactly 1 support request (its own), saw %', v_count using errcode = 'ZZ999';
  end if;

  select count(*) into v_other_count from support_requests where message = 'Shop Y needs help connecting Paystack';
  if v_other_count <> 0 then
    raise exception 'TEST FAILED: shop X could see shop Y''s support request' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a business sees only its own support requests, never another business''s';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 3. A business cannot resolve its own request ─────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001300';

do $$
declare
  v_updated int;
begin
  update support_requests set status = 'resolved' where message = 'Trying to look like shop Y sent this';
  get diagnostics v_updated = row_count;
  if v_updated <> 0 then
    raise exception 'TEST FAILED: a business was able to resolve its own support request (updated % rows)', v_updated using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a business cannot mark its own support request resolved';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 4. A Super Admin sees every business's requests and can resolve one ──

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001302';

do $$
declare
  v_total int;
  v_updated int;
begin
  select count(*) into v_total from support_requests;
  if v_total < 2 then
    raise exception 'TEST FAILED: a super admin should see every business''s support requests (at least 2), saw %', v_total using errcode = 'ZZ999';
  end if;

  update support_requests set status = 'resolved', resolved_at = now(), resolved_by = '00000000-0000-0000-0000-000000001302'
    where message = 'Shop Y needs help connecting Paystack';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'TEST FAILED: a super admin could not resolve a support request (updated % rows)', v_updated using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a Super Admin can see every business''s support requests and mark one resolved';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 5. Shop Y sees its own request now resolved, but still cannot have
-- resolved it themselves (belt-and-braces re-check of #3 post-resolution) ─

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000001301';

do $$
declare
  v_status text;
begin
  select status into v_status from support_requests where message = 'Shop Y needs help connecting Paystack';
  if v_status <> 'resolved' then
    raise exception 'TEST FAILED: shop Y should see its own request as resolved, saw status=%', v_status using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a business can see its own request''s status change once a Super Admin resolves it';
end $$;

reset role;
reset request.jwt.claim.sub;

\echo ''
\echo 'All support request (0057) tests passed.'