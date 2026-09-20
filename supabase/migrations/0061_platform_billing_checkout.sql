-- Busihub — 0061: Paystack self-serve checkout, billing webhook, and
-- cancellation (Phase 19, part 2 of 2)
--
-- The second half of "let a business self-serve upgrade with real money
-- moving to Busihub" — migration 0060 only linked a plan to a Paystack
-- Plan object; nothing before this migration lets a business actually
-- pay anything. This is the money-moving half: a business can now start
-- a Paystack-hosted checkout for a paid plan, Paystack auto-charges it
-- every period going forward, and a platform-level webhook
-- (app/api/webhooks/paystack-platform) is what actually flips the
-- business onto that plan — never a client redirect, same "the webhook
-- is the only source of truth for money" rule settle_sale_payment()
-- already established for the per-shop side (0022).
--
-- ── new state on business_subscriptions ──────────────────────────────────
--   paystack_customer_code, paystack_subscription_code, paystack_email_token
--   — Paystack's own identifiers for this business's subscription.
--   email_token is not a secret in the usual sense but it IS what
--   authorizes cancelling the subscription via Paystack's own API
--   (POST /subscription/disable needs both code and token) — Paystack's
--   documented design, not this codebase's choice.
--
-- ── two new service-role-only tables ─────────────────────────────────────
--   platform_billing_checkouts: one row per self-serve checkout attempt,
--   created by start_plan_checkout() the moment a business clicks
--   "Subscribe", BEFORE they are ever redirected to Paystack. Lets the
--   webhook tell "this charge.success is the FIRST charge of a new
--   self-serve subscription" apart from "this is a routine renewal
--   charge" — a renewal charge never has a reference that matches a row
--   here, since Paystack generates that reference itself, not
--   start_plan_checkout().
--   platform_paystack_events: idempotency for this webhook, same
--   reasoning and shape as paystack_events (0022) for the per-shop
--   webhook — Paystack retries an unacknowledged webhook for up to 72
--   hours, so a repeat delivery is the ordinary case, not an anomaly.
--   Deliberately a SEPARATE table from paystack_events rather than
--   reusing it: that table's business_id column and "which shop's
--   webhook was this" framing belong to a different Paystack account
--   (a shop's own) than this one (Busihub's own) — conflating the two
--   would blur which integration an event actually came from.
--
-- ── five new service-role-only functions ──────────────────────────────────
-- Every one of them re-validates its own business_id exists in
-- business_subscriptions (P0002 if not) and writes exactly one
-- log_audit_event() row — the same "one function, one write, one
-- guaranteed audit entry" shape as admin_set_business_subscription()
-- (0058) and admin_upsert_subscription_plan() (0059/0060), just driven
-- by a webhook instead of a Super Admin's own hand:
--   platform_billing_activate_subscription — the first successful charge
--     of a new self-serve subscription: business_subscriptions moves to
--     the chosen plan, status 'active', a fresh current_period_start.
--   platform_billing_link_subscription — fills in
--     paystack_subscription_code/email_token/current_period_end once
--     Paystack's OWN subscription.create event confirms them (matched by
--     paystack_customer_code, not by reference — a different Paystack
--     event, on a different schedule, with no shared reference field —
--     see the webhook route's own comment for why this two-step linking
--     is the safer design here).
--   platform_billing_record_renewal — a later period's charge succeeded;
--     bumps current_period_end and clears any past_due grace period.
--   platform_billing_record_payment_failed — a renewal charge failed;
--     moves an ACTIVE subscription into past_due (only from 'active',
--     never re-triggered by a second failure on an already-past_due one
--     — Paystack itself retries a failed card several times before
--     giving up, and re-stamping past_due_since on every retry would
--     keep resetting process_subscription_lifecycle()'s (0058) 3-day
--     grace clock forever).
--   platform_billing_record_cancel_scheduled — Paystack confirmed the
--     subscription won't renew (whether the business asked via the new
--     "Cancel subscription" button, or Paystack itself gave up after
--     enough failed retries). Sets cancel_at_period_end — the EXACT flag
--     process_subscription_lifecycle() already watches (0058, section 3)
--     to move an active subscription to 'cancelled' once its current
--     period genuinely ends. No new lifecycle logic needed at all.
--
-- ── one new authenticated-callable function ───────────────────────────────
--   start_plan_checkout(p_plan_id) — re-checks business.manage itself
--   (never trusts the page that calls it), confirms the plan is active
--   AND already linked to Paystack (paystack_plan_code is not null —
--   0060), and records the pending checkout. Returns a reference for the
--   caller (app/(app)/settings/billing/actions.ts) to hand to Paystack's
--   own transaction/initialize call.
--
-- ── what this migration deliberately does NOT let a business do ─────────
--   Switch from one PAID self-serve plan to another while already
--   active. The billing page only offers the plan picker when the
--   business is NOT already on an active, Paystack-linked subscription
--   (trialing/past_due/expired/cancelled, or active-but-manually-assigned
--   by a Super Admin with no Paystack link at all) — a business already
--   self-serve-subscribed sees a "Cancel subscription" control instead.
--   Changing plans while active would mean deciding what happens to the
--   OLD Paystack subscription (disable it? prorate the difference?) —
--   out of scope for this delivery; a Super Admin can still move any
--   business to any plan by hand today via admin_set_business_subscription()
--   exactly as before, self-serve or not.
--
-- ── one thing this migration cannot make true by itself ──────────────────
-- Every SQL statement here is verified against a real local Postgres 16
-- (tests/security/entitlements.sql). The actual Paystack webhook PAYLOAD
-- SHAPES the route handler reads (event.data.customer.customer_code,
-- event.data.next_payment_date, which field an invoice event nests its
-- subscription code under, and so on) are written to Paystack's own
-- documented contract as closely as this project's authors could verify
-- without a reachable Paystack account from this sandbox — see the
-- webhook route's own file header for exactly which fields are read
-- defensively (multiple possible locations checked) because of that.
-- This absolutely needs a real Paystack TEST-mode subscription
-- run-through — sign up, subscribe, watch the webhook actually land and
-- the business actually flip to 'active' — before it goes near a live
-- key.

-- ── business_subscriptions: Paystack identifiers ─────────────────────────

alter table business_subscriptions add column paystack_customer_code text;
alter table business_subscriptions add column paystack_subscription_code text;
alter table business_subscriptions add column paystack_email_token text;

alter table business_subscriptions
  add constraint business_subscriptions_paystack_subscription_code_key unique (paystack_subscription_code);

create index business_subscriptions_paystack_customer_code_idx
  on business_subscriptions (paystack_customer_code)
  where paystack_customer_code is not null;

comment on column business_subscriptions.paystack_customer_code is
  'Set by platform_billing_activate_subscription() from the customer object on the FIRST successful checkout charge (charge.success). Used to match the LATER, separate subscription.create webhook event back to this business (see platform_billing_link_subscription()) — that event carries no reference field of its own to match on, only the same customer_code.';
comment on column business_subscriptions.paystack_subscription_code is
  'Set by platform_billing_link_subscription() once Paystack''s subscription.create event confirms it. Every later webhook event about this subscription (a renewal, a failed charge, a cancellation) is matched back to this business by this column — never by business_id, which Paystack''s own subscription/invoice events do not carry.';
comment on column business_subscriptions.paystack_email_token is
  'Required, alongside paystack_subscription_code, to call Paystack''s own POST /subscription/disable — Paystack''s documented design for authorizing a cancellation, not a secret Busihub invented. Not encrypted at rest (unlike a shop''s own Paystack secret key, lib/crypto/secret-box.ts) — it authorizes cancelling ONE subscription via Paystack''s API, not general account access.';

-- ── platform_billing_checkouts: pending self-serve checkouts ──────────────

create table platform_billing_checkouts (
  reference   uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  plan_id     uuid not null references subscription_plans(id),
  created_at  timestamptz not null default now(),
  consumed_at timestamptz
);

comment on table platform_billing_checkouts is
  'One row per self-serve checkout attempt, created by start_plan_checkout() before the business is ever redirected to Paystack. Lets the webhook (app/api/webhooks/paystack-platform) tell a brand-new subscription''s first charge.success apart from a routine renewal''s — a renewal''s reference is one Paystack generates itself and will never match a row here. consumed_at is set once that first charge has been acted on, so a duplicate delivery of the same charge.success (Paystack retries for up to 72 hours) is a safe no-op even if platform_paystack_events'' own idempotency check were somehow bypassed.';

alter table platform_billing_checkouts enable row level security;
-- Service role only, same as paystack_events (0022): no policy, no
-- grants to authenticated/anon. The only authenticated-reachable path
-- that writes this table is start_plan_checkout() below, which is
-- SECURITY DEFINER and so writes as this table's owner regardless of
-- what's granted to the authenticated role.
revoke all on platform_billing_checkouts from authenticated, anon;

-- ── platform_paystack_events: webhook idempotency ─────────────────────────

create table platform_paystack_events (
  id          text primary key,
  event_type  text not null,
  payload     jsonb not null,
  received_at timestamptz not null default now()
);

comment on table platform_paystack_events is
  'Every platform-billing webhook event accepted from Paystack, keyed by a composite of the event type and whichever identifier that event type actually carries (subscription_code for subscription.* events, reference for charge.success, the numeric id otherwise) — Paystack retries an unacknowledged webhook for up to 72 hours, so a repeat delivery is the ordinary case. A SEPARATE table from paystack_events (0022, the per-shop webhook''s own idempotency table) on purpose: these are two different Paystack accounts (a shop''s own vs. Busihub''s own), and paystack_events'' business_id column/framing belongs specifically to the per-shop one.';

alter table platform_paystack_events enable row level security;
revoke all on platform_paystack_events from authenticated, anon;

-- ── start_plan_checkout(): begin a self-serve upgrade ─────────────────────

create or replace function start_plan_checkout(p_plan_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_business_id uuid;
  v_plan subscription_plans%rowtype;
  v_reference uuid;
begin
  select business_id into v_business_id from profiles where id = v_caller;
  if v_business_id is null then
    raise exception 'Caller is not linked to a business' using errcode = '42501';
  end if;

  if not (app_has_permission(v_business_id, 'business.manage') or app_is_super_admin()) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select * into v_plan from subscription_plans where id = p_plan_id and is_active;
  if v_plan.id is null then
    raise exception 'Plan not found or no longer available' using errcode = 'P0002';
  end if;

  if v_plan.paystack_plan_code is null then
    raise exception 'This plan is not available for self-serve upgrade yet' using errcode = 'P0001';
  end if;

  v_reference := gen_random_uuid();

  insert into platform_billing_checkouts (reference, business_id, plan_id)
  values (v_reference, v_business_id, p_plan_id);

  return v_reference;
end;
$$;

comment on function start_plan_checkout(uuid) is
  'Records a pending self-serve checkout and returns its reference, for app/(app)/settings/billing/actions.ts to hand to Paystack''s transaction/initialize call alongside the plan''s paystack_plan_code. Re-checks business.manage itself, never trusting the page that calls it — same convention as every other privileged write in this schema. Rejects a plan that is inactive, unknown, or not yet linked to Paystack (paystack_plan_code null, 0060) with a friendly, already-user-facing message rather than proceeding to a checkout that could never succeed.';

revoke all on function start_plan_checkout(uuid) from public, anon;
grant execute on function start_plan_checkout(uuid) to authenticated;

-- ── platform_billing_activate_subscription(): first charge succeeded ──────

create or replace function platform_billing_activate_subscription(
  p_business_id uuid,
  p_plan_id uuid,
  p_paystack_customer_code text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_status subscription_status;
  v_plan_name text;
begin
  select status into v_old_status from business_subscriptions where business_id = p_business_id;
  if v_old_status is null then
    raise exception 'This business has no subscription row to update' using errcode = 'P0002';
  end if;

  select name into v_plan_name from subscription_plans where id = p_plan_id;

  update business_subscriptions set
    plan_id               = p_plan_id,
    status                = 'active',
    current_period_start  = now(),
    cancel_at_period_end  = false,
    past_due_since        = null,
    paystack_customer_code = p_paystack_customer_code,
    updated_at            = now()
  where business_id = p_business_id;

  perform log_audit_event(
    p_business_id, null, 'platform.subscription_activated', 'business_subscription', p_business_id,
    jsonb_build_object('plan_id', p_plan_id, 'plan_name', v_plan_name, 'from_status', v_old_status)
  );
end;
$$;

comment on function platform_billing_activate_subscription(uuid, uuid, text) is
  'Called only from app/api/webhooks/paystack-platform on a charge.success matched to a pending platform_billing_checkouts row — the FIRST successful charge of a new self-serve subscription. Moves the business onto the chosen plan, active, with a fresh current_period_start. Deliberately does not set paystack_subscription_code/email_token here — those arrive on a SEPARATE, later subscription.create event (see platform_billing_link_subscription()).';

revoke all on function platform_billing_activate_subscription(uuid, uuid, text) from public, anon, authenticated;
grant execute on function platform_billing_activate_subscription(uuid, uuid, text) to service_role;

-- ── platform_billing_link_subscription(): Paystack confirmed the subscription itself ──

create or replace function platform_billing_link_subscription(
  p_business_id uuid,
  p_paystack_subscription_code text,
  p_paystack_email_token text,
  p_current_period_end timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from business_subscriptions where business_id = p_business_id) then
    raise exception 'This business has no subscription row to update' using errcode = 'P0002';
  end if;

  update business_subscriptions set
    paystack_subscription_code = p_paystack_subscription_code,
    paystack_email_token       = p_paystack_email_token,
    current_period_end         = coalesce(p_current_period_end, current_period_end),
    updated_at                 = now()
  where business_id = p_business_id;

  perform log_audit_event(
    p_business_id, null, 'platform.subscription_linked', 'business_subscription', p_business_id,
    jsonb_build_object('paystack_subscription_code', p_paystack_subscription_code)
  );
end;
$$;

comment on function platform_billing_link_subscription(uuid, text, text, timestamptz) is
  'Called only from app/api/webhooks/paystack-platform on Paystack''s own subscription.create event, matched back to a business by paystack_customer_code (set moments earlier by platform_billing_activate_subscription — this event carries no reference field to match on directly). p_current_period_end is nullable and coalesced against the existing value on purpose: exactly which field of this event carries the next billing date has not been verified against a real Paystack account from this sandbox (see migration 0061''s own header) — if it is ever read as null, this leaves current_period_end unchanged rather than clobbering it, a safe degraded outcome rather than silent data loss.';

revoke all on function platform_billing_link_subscription(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function platform_billing_link_subscription(uuid, text, text, timestamptz) to service_role;

-- ── platform_billing_record_renewal(): a later period's charge succeeded ──

create or replace function platform_billing_record_renewal(
  p_business_id uuid,
  p_current_period_end timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_status subscription_status;
begin
  select status into v_old_status from business_subscriptions where business_id = p_business_id;
  if v_old_status is null then
    raise exception 'This business has no subscription row to update' using errcode = 'P0002';
  end if;

  update business_subscriptions set
    status              = 'active',
    current_period_end  = coalesce(p_current_period_end, current_period_end),
    past_due_since       = null,
    updated_at          = now()
  where business_id = p_business_id;

  perform log_audit_event(
    p_business_id, null, 'platform.subscription_renewed', 'business_subscription', p_business_id,
    jsonb_build_object('from_status', v_old_status, 'current_period_end', p_current_period_end)
  );
end;
$$;

comment on function platform_billing_record_renewal(uuid, timestamptz) is
  'Called only from app/api/webhooks/paystack-platform when a RENEWAL charge (not the first one — see platform_billing_activate_subscription for that) succeeds. Moves status back to active unconditionally, which also recovers a subscription that had drifted into past_due after an earlier failed retry — Paystack itself retries a failed card several times before giving up, and a later success on one of those retries is a real, expected case, not an edge case.';

revoke all on function platform_billing_record_renewal(uuid, timestamptz) from public, anon, authenticated;
grant execute on function platform_billing_record_renewal(uuid, timestamptz) to service_role;

-- ── platform_billing_record_payment_failed(): a renewal charge failed ─────

create or replace function platform_billing_record_payment_failed(
  p_business_id uuid,
  p_failure_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_status subscription_status;
begin
  select status into v_old_status from business_subscriptions where business_id = p_business_id;
  if v_old_status is null then
    raise exception 'This business has no subscription row to update' using errcode = 'P0002';
  end if;

  -- Only a currently-active subscription moves to past_due here, and
  -- only ever the FIRST time — Paystack retries a failed renewal charge
  -- several times over several days before giving up, and re-stamping
  -- past_due_since on every one of those retries would keep pushing
  -- process_subscription_lifecycle()'s (0058) 3-day grace clock forward
  -- indefinitely, so a business could never actually reach the expired
  -- lockout no matter how long its card kept failing.
  if v_old_status = 'active' then
    update business_subscriptions set
      status         = 'past_due',
      past_due_since = now(),
      updated_at     = now()
    where business_id = p_business_id;
  end if;

  perform log_audit_event(
    p_business_id, null, 'platform.subscription_payment_failed', 'business_subscription', p_business_id,
    jsonb_build_object('from_status', v_old_status, 'failure_reason', p_failure_reason)
  );
end;
$$;

comment on function platform_billing_record_payment_failed(uuid, text) is
  'Called only from app/api/webhooks/paystack-platform on invoice.payment_failed. Moves an active subscription into the SAME past_due grace period process_subscription_lifecycle() (0058) already drives toward expired after 3 days — no new lifecycle logic needed. A no-op status-wise (but still logged) if the subscription is not currently active, so Paystack retrying an already-failed renewal cannot keep re-extending the grace window.';

revoke all on function platform_billing_record_payment_failed(uuid, text) from public, anon, authenticated;
grant execute on function platform_billing_record_payment_failed(uuid, text) to service_role;

-- ── platform_billing_record_cancel_scheduled(): won't renew ───────────────

create or replace function platform_billing_record_cancel_scheduled(p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_status subscription_status;
begin
  select status into v_old_status from business_subscriptions where business_id = p_business_id;
  if v_old_status is null then
    raise exception 'This business has no subscription row to update' using errcode = 'P0002';
  end if;

  update business_subscriptions set
    cancel_at_period_end = true,
    updated_at            = now()
  where business_id = p_business_id;

  perform log_audit_event(
    p_business_id, null, 'platform.subscription_cancel_scheduled', 'business_subscription', p_business_id,
    jsonb_build_object('from_status', v_old_status)
  );
end;
$$;

comment on function platform_billing_record_cancel_scheduled(uuid) is
  'Called only from app/api/webhooks/paystack-platform on subscription.disable or subscription.not_renew — whether the business asked (the new "Cancel subscription" button calling Paystack''s own /subscription/disable) or Paystack gave up after enough failed renewal retries. Sets cancel_at_period_end, the exact flag process_subscription_lifecycle() (0058, section 3) already watches to move an active subscription to cancelled once its current period genuinely ends — access is not revoked immediately, same as every other cancellation path in this schema.';

revoke all on function platform_billing_record_cancel_scheduled(uuid) from public, anon, authenticated;
grant execute on function platform_billing_record_cancel_scheduled(uuid) to service_role;