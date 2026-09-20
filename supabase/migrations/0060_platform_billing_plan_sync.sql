-- Busihub — 0060: Paystack plan sync (Phase 19, part 1 of 2)
--
-- The second half of "let a business self-serve upgrade with real money
-- moving to Busihub" (the first half, migration 0059, only let Super
-- Admin set what a plan costs — see docs/ARCHITECTURE.md Section 9's
-- still-open gap). This is genuinely two deliveries, not one, because
-- the actual money-moving piece (checkout, a webhook, cancellation) is
-- large enough on its own that shipping it alongside a schema change
-- would make either one harder to verify in isolation. This delivery is
-- schema-and-plan-sync only: nothing here lets a business pay anything
-- yet, and nothing here changes what a business can already do.
--
-- What this adds:
--   1. subscription_plans.paystack_plan_code — the Paystack "Plan" object
--      a business will subscribe to, once self-serve checkout exists.
--      Nullable: the free trial plan (billing_interval = 'none', price 0)
--      never gets one, and a plan created before Busihub's own Paystack
--      account existed simply has none yet either — both are normal,
--      not error states.
--   2. admin_upsert_subscription_plan() (0059) gains one new trailing
--      parameter, p_paystack_plan_code. Postgres identifies a function by
--      name AND its exact argument type list, so adding a parameter —
--      even a defaulted one — does not "replace" the old 10-argument
--      function at all; left alone, the two would coexist as separate
--      overloads, and the old one (with no idea paystack_plan_code
--      exists) would still be reachable. The old signature is dropped
--      explicitly below before the new one is created — the same
--      "drop function if exists <old signature>, then create" shape this
--      codebase has used for every previous parameter-count change to a
--      function (0026/0040/0041/0046 all did this to create_product()
--      itself; see any of their own headers for the same reasoning).
--
-- What this deliberately does NOT do: call Paystack's API from inside
-- Postgres. Postgres has no outbound HTTP of its own in this project (no
-- pg_net, no equivalent extension enabled) — the actual "ask Paystack to
-- create or update a Plan object" call happens in
-- lib/paystack/platform-client.ts, from app/admin/plans/actions.ts,
-- BEFORE this RPC is called; this migration only adds somewhere to store
-- the code that call returns. A Paystack API hiccup during that call is
-- treated as best-effort, logged, non-blocking (see that action's own
-- comment) — the plan still saves either way, it just isn't offered for
-- self-serve checkout until sync succeeds.

alter table subscription_plans add column paystack_plan_code text;

alter table subscription_plans
  add constraint subscription_plans_paystack_plan_code_key unique (paystack_plan_code);

comment on column subscription_plans.paystack_plan_code is
  'The Paystack Plan object this plan is linked to — set by app/admin/plans/actions.ts after a successful create/update call to Paystack''s own Plan API (lib/paystack/platform-client.ts), never written directly by this database. Null means either "this plan is free/one-time and was never meant to have one" (billing_interval = ''none'' or price_amount = 0) or "Paystack sync has not succeeded yet" — the two are told apart by price_amount/billing_interval, not by this column alone. A plan with no paystack_plan_code cannot be offered on the self-serve checkout page once that exists (migration 0061) — it can still be assigned to a business by hand, exactly as every plan already can be today.';

drop function if exists admin_upsert_subscription_plan(uuid, text, text, text, numeric, text, text, jsonb, boolean, integer);

create or replace function admin_upsert_subscription_plan(
  p_id                  uuid,
  p_slug                text,
  p_name                text,
  p_description         text,
  p_price_amount        numeric,
  p_currency_code       text,
  p_billing_interval    text,
  p_limits              jsonb,
  p_is_active           boolean,
  p_sort_order          integer,
  p_paystack_plan_code  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_slug text := lower(trim(coalesce(p_slug, '')));
  v_name text := trim(coalesce(p_name, ''));
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_currency_code text := upper(trim(coalesce(p_currency_code, '')));
  -- Blank string normalized to null the same way v_description is —
  -- app/admin/plans/actions.ts always passes either a real Paystack plan
  -- code or null, never '', but this RPC is reachable directly via
  -- supabase.rpc() and must not trust that.
  v_paystack_plan_code text := nullif(trim(coalesce(p_paystack_plan_code, '')), '');
  v_action text;
begin
  if not app_is_super_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if v_slug = '' or v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'Plan slug must be lowercase letters, numbers, and hyphens only (e.g. "starter-plus").' using errcode = '22023';
  end if;

  if v_name = '' then
    raise exception 'Plan name is required.' using errcode = '22023';
  end if;

  if p_price_amount is null or p_price_amount < 0 then
    raise exception 'Plan price cannot be negative.' using errcode = '22023';
  end if;

  if v_currency_code !~ '^[A-Z]{3}$' then
    raise exception 'Currency code must be a 3-letter code (e.g. GHS, USD).' using errcode = '22023';
  end if;

  if p_billing_interval not in ('month', 'year', 'none') then
    raise exception 'Billing interval must be "month", "year", or "none".' using errcode = '22023';
  end if;

  perform app_validate_plan_limits(p_limits);

  if exists (select 1 from subscription_plans where slug = v_slug and id is distinct from p_id) then
    raise exception 'A plan with the slug "%" already exists — choose a different one.', v_slug using errcode = '23505';
  end if;

  if v_paystack_plan_code is not null
     and exists (select 1 from subscription_plans where paystack_plan_code = v_paystack_plan_code and id is distinct from p_id) then
    raise exception 'This Paystack plan is already linked to another plan here — something went wrong during sync.' using errcode = '23505';
  end if;

  if p_id is null then
    v_action := 'platform.subscription_plan_created';

    insert into subscription_plans (
      slug, name, description, price_amount, currency_code, billing_interval, limits, is_active, sort_order,
      paystack_plan_code
    ) values (
      v_slug, v_name, v_description, p_price_amount, v_currency_code, p_billing_interval, p_limits,
      coalesce(p_is_active, true), coalesce(p_sort_order, 0), v_paystack_plan_code
    )
    returning id into v_id;
  else
    v_action := 'platform.subscription_plan_updated';

    if not exists (select 1 from subscription_plans where id = p_id) then
      raise exception 'Plan not found' using errcode = 'P0002';
    end if;

    update subscription_plans set
      slug               = v_slug,
      name               = v_name,
      description        = v_description,
      price_amount       = p_price_amount,
      currency_code      = v_currency_code,
      billing_interval   = p_billing_interval,
      limits             = p_limits,
      is_active          = coalesce(p_is_active, true),
      sort_order         = coalesce(p_sort_order, 0),
      paystack_plan_code = v_paystack_plan_code
    where id = p_id;

    v_id := p_id;
  end if;

  perform log_audit_event(
    null, null, v_action, 'subscription_plan', v_id,
    jsonb_build_object(
      'slug', v_slug, 'name', v_name, 'price_amount', p_price_amount, 'currency_code', v_currency_code,
      'billing_interval', p_billing_interval, 'limits', p_limits, 'is_active', coalesce(p_is_active, true),
      'sort_order', coalesce(p_sort_order, 0), 'paystack_plan_code', v_paystack_plan_code
    )
  );

  return v_id;
end;
$$;

comment on function admin_upsert_subscription_plan(uuid, text, text, text, numeric, text, text, jsonb, boolean, integer, text) is
  'Super-Admin-only create/update for the subscription_plans catalog (pricing, limits, name, and — since 0060 — the linked Paystack plan_code) — the write path behind /admin/plans. p_id null creates a new plan; a real p_id updates that row (rejecting an unknown one with P0002). p_paystack_plan_code is set by app/admin/plans/actions.ts after it calls Paystack''s own Plan API directly (this function never talks to Paystack itself) — null is the normal value for a free/one-time plan, or a paid plan whose Paystack sync has not succeeded yet. Re-checks app_is_super_admin() itself, same as every other Super Admin write (bootstrap_super_admin 0035, admin_set_business_subscription 0058). Deleting a plan is deliberately not supported: retire one with p_is_active = false instead.';

revoke all on function admin_upsert_subscription_plan(uuid, text, text, text, numeric, text, text, jsonb, boolean, integer, text) from public, anon, authenticated;
grant execute on function admin_upsert_subscription_plan(uuid, text, text, text, numeric, text, text, jsonb, boolean, integer, text) to authenticated;