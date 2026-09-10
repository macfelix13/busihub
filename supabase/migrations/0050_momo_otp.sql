-- Busihub — 0050: mobile money charges that need an OTP no longer stall
-- forever.
--
-- Paystack's Charge API has a state this app never handled: instead of
-- (or sometimes before) prompting the customer's phone directly, Paystack
-- can send the customer a one-time code by SMS and return
-- `data.status: "send_otp"` with `data.display_text` telling the cashier
-- what to show. Completing the charge then requires a SEPARATE call —
-- `POST /charge/submit_otp` with `{ otp, reference }` — before Paystack
-- will settle it at all.
--
-- lib/paystack/client.ts's normaliseStatus() previously folded "send_otp"
-- into the same generic "pending" bucket as "pay_offline"/"ongoing", and
-- nothing anywhere ever called submit_otp. The result: a charge that
-- needed an OTP just sat there — the customer got a text message with a
-- code, but the till had nothing to type it into — until Paystack's own
-- ~180-second window ran out and it read as a plain, unexplained decline.
-- This is a real production report (2026-09): "paystack sends code to
-- their sms instead [of a] prompt to enter their code right away".
--
-- This migration is the DB half of the fix — a way to record that a
-- pending momo tender is specifically waiting on an OTP, and what to show
-- the cashier while it does. The application-code half (submitting the
-- OTP, and the till UI to collect it) ships alongside this migration in
-- the same apply script.

-- ── sale_payments: flag + prompt text for the OTP-required state ────────

alter table sale_payments
  add column awaiting_otp boolean not null default false,
  add column otp_prompt_text text;

comment on column sale_payments.awaiting_otp is
  'True while this pending momo tender is specifically waiting on a one-time code Paystack sent the customer by SMS (Charge API status "send_otp") — as opposed to a plain "approve the prompt on your phone" wait. Set by mark_momo_payment_awaiting_otp(), cleared by settle_sale_payment() the moment the payment settles either way.';

comment on column sale_payments.otp_prompt_text is
  'Paystack''s own display_text for the OTP prompt (e.g. "A 6-digit OTP has been sent to your mobile number") — shown to the cashier verbatim rather than a made-up message, since the exact wording sometimes carries provider-specific instructions.';

-- ── mark_momo_payment_awaiting_otp(): the one way to set the flag ────────
--
-- Same shape and same reasoning as settle_sale_payment() (0022/0023):
-- SECURITY DEFINER, service_role only, business_id passed explicitly and
-- checked against the payment's own row rather than trusted — the caller
-- (promptCustomerPhone(), app/(app)/till/actions.ts) already proved which
-- business it is via the cashier's own RLS-scoped read of this exact
-- payment row before ever reaching here. sale_payments still grants
-- UPDATE to nobody (0022's own comment: "which is what stops a cashier
-- marking their own momo prompt as received") — this function is
-- deliberately narrow: it can only move a PENDING payment into the
-- awaiting-OTP state, nothing else, and never touches status itself.

create or replace function mark_momo_payment_awaiting_otp(
  p_business_id uuid,
  p_payment_id uuid,
  p_prompt_text text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment sale_payments%rowtype;
begin
  select * into v_payment from sale_payments where id = p_payment_id for update;

  if v_payment.id is null then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;

  if p_business_id is null or v_payment.business_id <> p_business_id then
    raise exception 'That payment belongs to another business' using errcode = '42501';
  end if;

  -- Already settled by the time this runs (a fast webhook, or a race
  -- with the initial charge response) — nothing left to flag as
  -- awaiting anything, and definitely not worth overwriting a real
  -- outcome with a stale "still needs an OTP" flag.
  if v_payment.status <> 'pending' then
    return;
  end if;

  update sale_payments
  set awaiting_otp = true,
      otp_prompt_text = p_prompt_text
  where id = p_payment_id;
end;
$$;

revoke all on function mark_momo_payment_awaiting_otp(uuid, uuid, text) from public, authenticated, anon;
grant execute on function mark_momo_payment_awaiting_otp(uuid, uuid, text) to service_role;

comment on function mark_momo_payment_awaiting_otp(uuid, uuid, text) is
  'Flags a still-pending momo tender as waiting on a Paystack OTP, and records what to show the cashier. Scoped to the business the caller proved it is, same pattern as settle_sale_payment(). service_role only — sale_payments grants UPDATE to nobody, by design (0022).';

-- ── settle_sale_payment(): also clears the OTP flag ──────────────────────
--
-- Reproduced in full from 0023's current live body — unchanged except for
-- the two new columns being reset in the UPDATE, so a settled payment
-- never keeps showing a stale "still needs an OTP" prompt.

create or replace function settle_sale_payment(
  p_business_id uuid,
  p_payment_id uuid,
  p_status text,               -- 'success' | 'failed'
  p_provider_charge_id text,
  p_failure_reason text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment sale_payments%rowtype;
  v_sale    sales%rowtype;
  v_paid    numeric(14, 2);
begin
  if p_status not in ('success', 'failed') then
    raise exception 'A payment settles as success or failed' using errcode = '22023';
  end if;

  select * into v_payment from sale_payments where id = p_payment_id for update;
  if v_payment.id is null then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;

  -- The caller has proved it is this business (a webhook signature made
  -- with that shop's own secret key). It has not proved anything about a
  -- payment belonging to a different one.
  if p_business_id is null or v_payment.business_id <> p_business_id then
    raise exception 'That payment belongs to another business' using errcode = '42501';
  end if;

  -- A webhook retry, or the till's verify call racing the webhook. Both
  -- are routine, and neither is an error — report what already happened.
  if v_payment.status <> 'pending' then
    return v_payment.status;
  end if;

  update sale_payments
  set status = p_status,
      provider_charge_id = coalesce(p_provider_charge_id, provider_charge_id),
      failure_reason = case when p_status = 'failed' then p_failure_reason else null end,
      settled_at = now(),
      -- NEW in 0050: whatever OTP wait this payment was in is over now,
      -- one way or the other.
      awaiting_otp = false,
      otp_prompt_text = null
  where id = p_payment_id;

  if p_status = 'failed' then
    return 'failed';
  end if;

  select * into v_sale from sales where id = v_payment.sale_id;

  -- finalize_sale recomputes this itself and refuses a sale that is
  -- short, so this is only deciding whether it is worth asking. Cash is
  -- counted at what was handed over less the change that went back.
  select coalesce(sum(amount), 0) - v_sale.change_given into v_paid
  from sale_payments
  where sale_id = v_payment.sale_id and status = 'success';

  if v_paid >= v_sale.total and v_sale.status = 'awaiting_payment' then
    perform finalize_sale(v_sale.id);
    return 'completed';
  end if;

  return 'success';
end;
$$;

revoke all on function settle_sale_payment(uuid, uuid, text, text, text) from public, authenticated, anon;
grant execute on function settle_sale_payment(uuid, uuid, text, text, text) to service_role;

comment on function settle_sale_payment(uuid, uuid, text, text, text) is
  'Records the outcome of a mobile money charge and completes the sale once its payments cover the total. Scoped to the business the caller proved it is, so a signed webhook cannot settle another shop''s payment. Idempotent: a repeated webhook for a payment that is already settled returns the settled status and changes nothing. Clears awaiting_otp/otp_prompt_text on settlement (0050). service_role only.';