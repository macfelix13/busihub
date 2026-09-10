-- Busihub — 0051: show the customer's own network what Paystack actually
-- told us, not a generic message we made up.
--
-- 0050 assumed every non-final mobile money charge that needed the
-- cashier's attention was an OTP the customer had been texted. Real-world
-- testing (2026-09) plus a closer read of Paystack's own docs showed that
-- is only true for Vodafone/Telecel. For MTN and AirtelTigo, Paystack's
-- charge response comes back as "pay_offline": the customer approves
-- entirely on their OWN phone (a USSD prompt, or their Mobile Money PIN),
-- and there is nothing for a cashier to type anywhere. What the merchant
-- in this report saw — "the customer got an OTP by SMS, but the till just
-- shows waiting" — was Busihub working correctly for MTN; the actual gap
-- was that the waiting screen showed a generic line instead of Paystack's
-- own, more specific instructions, so nobody could tell the two cases
-- apart or knew what to tell a confused customer.
--
-- This migration generalises 0050's mark_momo_payment_awaiting_otp() into
-- record_momo_provider_prompt(): same SECURITY DEFINER / service_role-only
-- shape, but it can now record Paystack's own display_text for ANY
-- pending momo charge, with an explicit flag for whether this one
-- actually needs something typed back (Vodafone/Telecel) or is purely
-- informational (MTN/AirtelTigo, or anything else). awaiting_otp keeps its
-- exact original meaning — true only when a code genuinely needs to be
-- submitted — so the till only ever shows an OTP entry box when one is
-- really needed.

-- ── drop the narrower 0050 function; record_momo_provider_prompt replaces it ─

drop function if exists mark_momo_payment_awaiting_otp(uuid, uuid, text);

-- ── record_momo_provider_prompt(): the general form ──────────────────────

create or replace function record_momo_provider_prompt(
  p_business_id uuid,
  p_payment_id uuid,
  p_prompt_text text,
  p_awaiting_otp boolean
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

  -- Already settled by the time this runs (a fast webhook, or a race with
  -- the initial charge response) — nothing left to prompt anyone about,
  -- and definitely not worth overwriting a real outcome with stale
  -- guidance text.
  if v_payment.status <> 'pending' then
    return;
  end if;

  update sale_payments
  set awaiting_otp = p_awaiting_otp,
      otp_prompt_text = p_prompt_text
  where id = p_payment_id;
end;
$$;

revoke all on function record_momo_provider_prompt(uuid, uuid, text, boolean) from public, authenticated, anon;
grant execute on function record_momo_provider_prompt(uuid, uuid, text, boolean) to service_role;

comment on function record_momo_provider_prompt(uuid, uuid, text, boolean) is
  'Records what Paystack told us about a still-pending momo charge — its own instructions for the customer/cashier — and whether this specifically needs a code submitted back (Vodafone/Telecel "send_otp") or is purely informational (MTN/AirtelTigo "pay_offline", where the customer approves on their own phone and there is nothing to submit). Scoped to the business the caller proved it is, same pattern as settle_sale_payment(). service_role only — sale_payments grants UPDATE to nobody, by design (0022).';

-- ── column comments, updated for the broader use ─────────────────────────

comment on column sale_payments.awaiting_otp is
  'True while this pending momo tender specifically needs a code submitted back to Paystack (Charge API status "send_otp", currently only seen for Vodafone/Telecel) — as opposed to a charge the customer approves entirely on their own phone (MTN/AirtelTigo "pay_offline"), where this stays false even while a prompt is showing. Set by record_momo_provider_prompt(), cleared by settle_sale_payment() the moment the payment settles either way.';

comment on column sale_payments.otp_prompt_text is
  'Paystack''s own display_text for whatever this pending charge is waiting on — shown to the cashier verbatim instead of a generic message, since the exact wording differs by network and sometimes carries provider-specific instructions (a USSD code to dial, a PIN prompt, or an actual OTP to submit). Set regardless of whether awaiting_otp is true.';