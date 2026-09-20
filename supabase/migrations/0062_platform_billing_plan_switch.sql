-- Busihub — 0062: self-serve plan switching for an already-active
-- subscription (Phase 19 follow-up)
--
-- Migration 0061 deliberately scoped switching between two already-active
-- self-serve plans out of the first delivery — Settings -> Billing only
-- ever offered the checkout picker when the business was NOT already
-- active on a Paystack-managed plan. This migration removes that
-- restriction (the UI-side change lives in app/(app)/settings/billing/
-- page.tsx, not here): a business Owner/Manager can now switch to any
-- other Paystack-linked plan from the exact same Settings -> Billing
-- screen at any time, upgrade or downgrade, not just while trialing/
-- past_due/expired.
--
-- ── why this needs a real design decision, not just a UI change ──────────
-- Paystack has no "change this subscription's plan" endpoint. A switch is
-- therefore: a brand new checkout on the new plan (start_plan_checkout(),
-- already built — no change needed there beyond the one guard below),
-- which Paystack turns into a brand new subscription, PLUS explicitly
-- disabling the business's previous subscription once the new one is
-- confirmed — otherwise the business would end up on two live,
-- auto-renewing Paystack subscriptions and be charged for both forever.
--
-- The "once the new one is confirmed" part is deliberate, not incidental.
-- The disable-the-old-subscription HTTP call was considered for
-- charge.success time (when the new plan is first activated locally) but
-- moved into the LATER subscription.create handler instead, for a
-- concrete reason: Paystack's own confirmation that it disabled the old
-- subscription arrives later as its own webhook event
-- (subscription.disable), asynchronously and with no ordering guarantee
-- against the new subscription's own subscription.create event. If the
-- old subscription were disabled at charge.success time (before the new
-- subscription_code is known), an out-of-order subscription.disable
-- confirmation for the OLD code could still match business_subscriptions
-- by paystack_subscription_code (if subscription.create for the NEW one
-- hasn't landed yet to overwrite it) and wrongly flag the BRAND NEW
-- subscription as cancel_at_period_end — a business that just paid to
-- switch plans would see their new plan marked as "ending soon". Doing
-- the disable inside handleSubscriptionCreate instead — after this
-- migration's platform_billing_link_subscription() has already been
-- reached (so paystack_subscription_code has already moved on to the new
-- code before the disable-old call is even made) — means that race
-- cannot occur: an old-code disable confirmation arriving at any point
-- afterward simply won't match anything anymore. cancel_at_period_end is
-- ALSO reset to false unconditionally by platform_billing_link_subscription
-- below, as belt-and-suspenders against the same class of stale-event
-- ordering risk.
--
-- This still cannot be exercised against a real Paystack account from
-- this sandbox — same caveat as migration 0061 and lib/paystack/
-- platform-client.ts's own header. A genuine test-mode run needs to cover
-- this specifically: subscribe to plan A, then switch to plan B, and
-- confirm in the Paystack dashboard that plan A's subscription actually
-- shows disabled/complete afterward, not still live.

-- ── start_plan_checkout(): guard against re-subscribing to the current plan ──
-- Same signature as 0061 (no drop needed) — a business already active on
-- exactly this plan clicking "Subscribe"/"Switch" again would just be
-- charged a second time for nothing. The UI already excludes the current
-- plan from the picker (a plain .neq() on plan_id), so this is
-- defense-in-depth against a stale page/second tab, not the primary gate.
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
  v_current_plan_id uuid;
  v_current_status subscription_status;
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

  select plan_id, status into v_current_plan_id, v_current_status
    from business_subscriptions where business_id = v_business_id;
  if v_current_status = 'active' and v_current_plan_id = p_plan_id then
    raise exception 'This business is already subscribed to this plan' using errcode = 'P0001';
  end if;

  v_reference := gen_random_uuid();

  insert into platform_billing_checkouts (reference, business_id, plan_id)
  values (v_reference, v_business_id, p_plan_id);

  return v_reference;
end;
$$;

comment on function start_plan_checkout(uuid) is
  'Starts a self-serve Paystack checkout for one billing period of a plan — the FIRST step of either a brand new subscription or a switch away from an existing one (0062 removed the restriction on switching from an already-active plan). Records a pending platform_billing_checkouts row the webhook later matches by reference. Rejects: caller lacks business.manage, plan not found/inactive, plan not yet linked to Paystack (paystack_plan_code is null), or the business is already active on exactly this plan.';

-- ── platform_billing_activate_subscription(): now records the switch context, if any ──
-- Same signature as 0061 (no drop needed) — only the body and its audit
-- metadata changed. Behaviour for a first-ever subscribe is unchanged.
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
  v_old_plan_id uuid;
  v_plan_name text;
begin
  select status, plan_id into v_old_status, v_old_plan_id from business_subscriptions where business_id = p_business_id;
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
    jsonb_build_object(
      'plan_id', p_plan_id,
      'plan_name', v_plan_name,
      'from_status', v_old_status,
      'from_plan_id', v_old_plan_id
    )
  );
end;
$$;

comment on function platform_billing_activate_subscription(uuid, uuid, text) is
  'Called only from app/api/webhooks/paystack-platform on a charge.success matched to a pending platform_billing_checkouts row — the FIRST successful charge of either a brand new self-serve subscription or a plan switch (0062: from_plan_id in the audit metadata distinguishes the two — null means this was the business''s first subscribe). Deliberately does not itself touch paystack_subscription_code/email_token, or disable any previous Paystack subscription — see platform_billing_link_subscription() and this migration''s own header for why that happens later, not here.';

revoke all on function platform_billing_activate_subscription(uuid, uuid, text) from public, anon, authenticated;
grant execute on function platform_billing_activate_subscription(uuid, uuid, text) to service_role;

-- ── platform_billing_link_subscription(): now also the "close out the old one" step ──
-- Signature grows by one nullable, trailing parameter — the OLD 4-argument
-- shape is explicitly dropped first (this codebase's established
-- convention: appending a parameter without dropping the old signature
-- would leave it reachable as a stale, unaware overload — see migration
-- 0060's own header for the same reasoning applied to
-- admin_upsert_subscription_plan()).
drop function if exists platform_billing_link_subscription(uuid, text, text, timestamptz);

create or replace function platform_billing_link_subscription(
  p_business_id uuid,
  p_paystack_subscription_code text,
  p_paystack_email_token text,
  p_current_period_end timestamptz,
  p_previous_subscription_disabled boolean default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous_subscription_code text;
begin
  if not exists (select 1 from business_subscriptions where business_id = p_business_id) then
    raise exception 'This business has no subscription row to update' using errcode = 'P0002';
  end if;

  select paystack_subscription_code into v_previous_subscription_code
    from business_subscriptions where business_id = p_business_id;

  update business_subscriptions set
    paystack_subscription_code = p_paystack_subscription_code,
    paystack_email_token       = p_paystack_email_token,
    current_period_end         = coalesce(p_current_period_end, current_period_end),
    -- 0062: a subscription.create event always describes a freshly
    -- created, live Paystack subscription — never a pre-cancelled one —
    -- so this is unconditionally correct to reset here, and doubles as a
    -- safety net against the exact stale-event-ordering race this
    -- migration's own header describes (an old subscription's disable
    -- confirmation arriving out of order should never leave the NEW
    -- subscription looking like it's ending).
    cancel_at_period_end       = false,
    updated_at                 = now()
  where business_id = p_business_id;

  perform log_audit_event(
    p_business_id, null, 'platform.subscription_linked', 'business_subscription', p_business_id,
    jsonb_build_object(
      'paystack_subscription_code', p_paystack_subscription_code,
      'previous_paystack_subscription_code', v_previous_subscription_code,
      'previous_subscription_disabled', p_previous_subscription_disabled
    )
  );
end;
$$;

comment on function platform_billing_link_subscription(uuid, text, text, timestamptz, boolean) is
  'Called only from app/api/webhooks/paystack-platform on Paystack''s own subscription.create event, matched back to a business by paystack_customer_code (set moments earlier by platform_billing_activate_subscription — this event carries no reference field to match on directly). p_current_period_end is nullable and coalesced against the existing value on purpose: exactly which field of this event carries the next billing date has not been verified against a real Paystack account from this sandbox (see migration 0061''s own header) — if it is ever read as null, this leaves current_period_end unchanged rather than clobbering it. 0062: also the point where a self-serve PLAN SWITCH closes out the business''s previous subscription — the webhook route disables it (Paystack API call, best-effort) immediately before calling this function, and p_previous_subscription_disabled (null when there was no previous subscription to disable, i.e. a first-ever subscribe) is recorded here purely for audit visibility, never used to decide anything.';

revoke all on function platform_billing_link_subscription(uuid, text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function platform_billing_link_subscription(uuid, text, text, timestamptz, boolean) to service_role;