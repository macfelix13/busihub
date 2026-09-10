-- Busihub — security/behaviour test for the mobile money OTP flow
-- (migration 0050).
--
-- Paystack can answer a mobile money charge with "send_otp" instead of a
-- direct approval prompt: it texts the customer a one-time code, and the
-- charge settles only once that code is submitted back through a SEPARATE
-- call. Before 0050 nothing recorded that a pending tender was in this
-- state, so the till had no way to know it needed to collect a code at
-- all — this is what a real production report (2026-09) turned out to be.
--
-- What is worth testing here is the same shape of thing settle_sale_payment
-- already gets tested for: this is a SECURITY DEFINER function that mutates
-- a payment row on nobody's direct UPDATE grant, so it needs the same three
-- guarantees — an ordinary user cannot call it, a caller cannot use it to
-- touch a payment belonging to a different business, and it behaves
-- correctly (a no-op, not silent corruption) when called on a payment that
-- is not actually pending.
--
-- Run against a throwaway Postgres loaded with
-- tests/db-harness/00_stub_supabase.sql + supabase/migrations/*.sql +
-- supabase/seed.sql (see tests/security/README.md).
--
-- Every `TEST FAILED` raise carries SQLSTATE ZZ999, which no handler in
-- this file catches — so a wrongly-succeeding operation can never have its
-- own failure message swallowed by a handler written for a different,
-- expected rejection.

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures: two fresh, otherwise-unused businesses ─────────────────────
-- Self-contained on purpose, same reasoning as products_cross_tenant.sql:
-- this proves the cross-tenant check with two shops it fully controls,
-- rather than assuming what state an earlier test file left behind.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000120',
   'authenticated', 'authenticated', 'ownermotpm@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000121',
   'authenticated', 'authenticated', 'ownermotpn@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000120';
select register_business('Momo Otp Shop M', 'Kwabena', 'Asante');
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000121';
select register_business('Momo Otp Shop N', 'Efua', 'Mensah');
reset role;
reset request.jwt.claim.sub;

create table motp_ids as
select
  (select id from businesses where slug = 'momo-otp-shop-m') as biz_m,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'momo-otp-shop-m') and b.is_main) as branch_m,
  '00000000-0000-0000-0000-000000000120'::uuid as owner_m,
  (select id from businesses where slug = 'momo-otp-shop-n') as biz_n;

do $$
declare r record;
begin
  select * into r from motp_ids;
  if r.biz_m is null or r.branch_m is null or r.biz_n is null then
    raise exception 'TEST FIXTURE BROKEN: motp_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

grant select on motp_ids to authenticated;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000120';
select create_product(
  (select biz_m from motp_ids),
  'Momo Otp Test Sugar', null, null, 'each', 'standard',
  '{}'::text[],
  '[{"sku": "MOTP-1", "barcode": "", "variant_options": {}, "cost_price": 20, "selling_price": 40}]'::jsonb
);
reset role;
reset request.jwt.claim.sub;

create table motp_sugar as
select id from product_variants where sku = 'MOTP-1';
grant select on motp_sugar to authenticated;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000120';
insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
select branch_m, (select id from motp_sugar), 100, 'receive' from motp_ids;

-- ── helper: rings up a fresh momo sale, returns its (only) payment id ────
--
-- create_sale() must run as the authenticated cashier (RLS decides which
-- branch/business they may sell for), but CREATE TABLE needs a role with
-- CREATE on the public schema, which "authenticated" does not have — so
-- the id is carried out via a session GUC and the table is built after
-- the role is reset, the same ordering products_cross_tenant.sql uses.

do $$
declare v_sale uuid;
begin
  select create_sale(
    (select branch_m from motp_ids), (select owner_m from motp_ids), null, null, null,
    jsonb_build_array(jsonb_build_object('variant_id', (select id from motp_sugar), 'quantity', 1)),
    jsonb_build_array(jsonb_build_object(
      'method', 'momo', 'amount', 40, 'momo_number', '0244555000', 'momo_network', 'mtn'))
  ) into v_sale;
  perform set_config('busihub.test_motp_sale', v_sale::text, false);
end $$;

reset role;
reset request.jwt.claim.sub;

create table motp_pending as
select current_setting('busihub.test_motp_sale')::uuid as sale_id;
grant select on motp_pending to authenticated;

-- ── 1. An ordinary user cannot flag a payment as awaiting an OTP ─────────
--
-- sale_payments grants UPDATE to nobody (0022) on purpose. This function
-- is one of the two narrow doors around that, and it must stay
-- service_role-only exactly like settle_sale_payment.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000120';

do $$
declare v_pay uuid;
begin
  select id into v_pay from sale_payments p, motp_pending
  where p.sale_id = motp_pending.sale_id and p.method = 'momo';

  begin
    perform mark_momo_payment_awaiting_otp((select biz_m from motp_ids), v_pay, 'A code was texted to the customer.');
    raise exception 'TEST FAILED: an ordinary user flagged a payment as awaiting OTP' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: mark_momo_payment_awaiting_otp is refused to an ordinary user, same as settle_sale_payment';
  end;

  if (select awaiting_otp from sale_payments where id = v_pay) is distinct from false then
    raise exception 'TEST FAILED: the refused call still changed awaiting_otp' using errcode = 'ZZ999';
  end if;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── from here on, as the server: chargeMobileMoney() got "send_otp" back ─

set role service_role;

-- ── 2. Another business's "business_id" cannot flag shop M's payment ────

do $$
declare v_pay uuid;
begin
  select id into v_pay from sale_payments p, motp_pending
  where p.sale_id = motp_pending.sale_id and p.method = 'momo';

  begin
    perform mark_momo_payment_awaiting_otp((select biz_n from motp_ids), v_pay, 'Attacker prompt text');
    raise exception 'TEST FAILED: shop N flagged shop M''s payment as awaiting OTP' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a payment cannot be flagged as awaiting OTP by another business';
  end;

  -- And a null business id is not a wildcard, same guarantee 0023 gives
  -- settle_sale_payment.
  begin
    perform mark_momo_payment_awaiting_otp(null, v_pay, 'x');
    raise exception 'TEST FAILED: a null business id flagged a payment' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a missing business id is refused rather than treated as any business';
  end;

  if (select awaiting_otp from sale_payments where id = v_pay) is distinct from false then
    raise exception 'TEST FAILED: a refused cross-tenant call still changed awaiting_otp' using errcode = 'ZZ999';
  end if;
end $$;

-- ── 3. A payment that does not exist is P0002, not a silent no-op ───────

do $$
begin
  begin
    perform mark_momo_payment_awaiting_otp((select biz_m from motp_ids), gen_random_uuid(), 'x');
    raise exception 'TEST FAILED: flagging a nonexistent payment did not raise' using errcode = 'ZZ999';
  exception when no_data_found then
    raise notice 'PASS: flagging a nonexistent payment raises, rather than doing nothing quietly';
  end;
end $$;

-- ── 4. The legitimate call: flags the tender and records the prompt ─────

do $$
declare v_pay uuid; v_row record;
begin
  select id into v_pay from sale_payments p, motp_pending
  where p.sale_id = motp_pending.sale_id and p.method = 'momo';

  perform mark_momo_payment_awaiting_otp(
    (select biz_m from motp_ids), v_pay, 'A 6-digit OTP has been sent to your mobile number.'
  );

  select * into v_row from sale_payments where id = v_pay;
  if v_row.awaiting_otp is distinct from true then
    raise exception 'TEST FAILED: awaiting_otp is %, expected true', v_row.awaiting_otp using errcode = 'ZZ999';
  end if;
  if v_row.otp_prompt_text is distinct from 'A 6-digit OTP has been sent to your mobile number.' then
    raise exception 'TEST FAILED: otp_prompt_text was not recorded verbatim (got %)', v_row.otp_prompt_text
      using errcode = 'ZZ999';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'TEST FAILED: flagging awaiting-OTP should not itself change status (got %)', v_row.status
      using errcode = 'ZZ999';
  end if;

  perform set_config('busihub.test_otp_payment', v_pay::text, false);
  raise notice 'PASS: a pending momo tender can be flagged as awaiting an OTP, with the prompt text kept verbatim';
end $$;

-- ── 5. Settling the payment clears the OTP flag and prompt text ─────────
--
-- The whole point of clearing it in settle_sale_payment (not just here):
-- once the code is submitted and Paystack answers, nothing should keep
-- telling the till this tender is still waiting on a code.

do $$
declare v_pay uuid; v_sale uuid; v_result text; v_row record;
begin
  v_pay := current_setting('busihub.test_otp_payment')::uuid;
  select sale_id into v_sale from sale_payments where id = v_pay;

  select settle_sale_payment((select biz_m from motp_ids), v_pay, 'success', 'chg_otp_1', null) into v_result;
  if v_result <> 'completed' then
    raise exception 'TEST FAILED: settling the OTP-flagged tender returned %', v_result using errcode = 'ZZ999';
  end if;

  select * into v_row from sale_payments where id = v_pay;
  if v_row.status <> 'success' then
    raise exception 'TEST FAILED: the payment is % after settlement', v_row.status using errcode = 'ZZ999';
  end if;
  if v_row.awaiting_otp is distinct from false then
    raise exception 'TEST FAILED: awaiting_otp is still % after settlement', v_row.awaiting_otp
      using errcode = 'ZZ999';
  end if;
  if v_row.otp_prompt_text is not null then
    raise exception 'TEST FAILED: otp_prompt_text is still set after settlement (%)', v_row.otp_prompt_text
      using errcode = 'ZZ999';
  end if;

  if (select status from sales where id = v_sale) <> 'completed' then
    raise exception 'TEST FAILED: the sale did not complete once its OTP-gated tender settled' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: settling a payment clears awaiting_otp and otp_prompt_text, and completes the sale';
end $$;

-- ── 6. Flagging an already-settled payment is a no-op, not a lie ────────
--
-- A race is entirely possible: the webhook can settle a charge before the
-- till's own charge-response handler gets back to mark it awaiting a code
-- it will now never need. Overwriting a real outcome with a stale
-- "still needs an OTP" flag would be actively wrong, so this must change
-- nothing.

do $$
declare v_pay uuid; v_row record;
begin
  v_pay := current_setting('busihub.test_otp_payment')::uuid;

  -- Already 'success' from step 5.
  perform mark_momo_payment_awaiting_otp((select biz_m from motp_ids), v_pay, 'Stale prompt text');

  select * into v_row from sale_payments where id = v_pay;
  if v_row.awaiting_otp is distinct from false then
    raise exception 'TEST FAILED: flagging a settled payment set awaiting_otp to %', v_row.awaiting_otp
      using errcode = 'ZZ999';
  end if;
  if v_row.otp_prompt_text is not null then
    raise exception 'TEST FAILED: flagging a settled payment wrote prompt text (%)', v_row.otp_prompt_text
      using errcode = 'ZZ999';
  end if;
  if v_row.status <> 'success' then
    raise exception 'TEST FAILED: flagging a settled payment changed its status to %', v_row.status
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: flagging an already-settled payment as awaiting OTP is a no-op';
end $$;

reset role;