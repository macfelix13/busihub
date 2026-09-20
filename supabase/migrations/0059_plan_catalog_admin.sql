-- Busihub — 0059: Super Admin plan catalog management
--
-- Phase 18 (0058) enforced the subscription_plans catalog that has
-- existed since 0006, but gave Super Admin no way to actually manage
-- that catalog itself — every plan (trial/starter/growth/enterprise) has
-- only ever come from 0010's seed data, and the only write path 0058
-- added (admin_set_business_subscription()) ASSIGNS an existing plan to
-- a business, it doesn't create or edit a plan's own name/price/limits.
-- This migration closes that gap: Super Admin can now create a new plan
-- or edit an existing one's pricing and limits from a new /admin/plans
-- UI, the same "hand-operated, logged, Super-Admin-only" shape as
-- admin_set_business_subscription() itself.
--
-- What this deliberately does NOT do: change a business's price when its
-- plan's price changes (a business already on 'growth' keeps whatever
-- current_period_end/billing it already has — this only changes what a
-- FUTURE assignment to that plan means), or support deleting a plan
-- (retire one with is_active = false instead — see
-- admin_upsert_subscription_plan()'s own comment for why). It also does
-- not touch real payment collection at all — that is still the
-- documented gap in docs/ARCHITECTURE.md Section 9 and 0058's own file
-- header, unaffected by this migration.
--
-- subscription_plans_write (0009, RLS) already lets a Super Admin write
-- this table directly (`for all using app_is_super_admin()`), so this
-- migration's RPC isn't closing a security hole RLS left open — it exists
-- for the same reason admin_set_business_subscription() does despite
-- business_subscriptions having no such direct-write policy at all:
-- validation (a plan's limits jsonb is read by app_enforce_limit() with
-- no schema of its own to catch a typo'd key — app_validate_plan_limits()
-- below is what stands in for that schema) and a single, reliable place
-- to log the change (log_audit_event()), rather than trusting the
-- application layer to always do both correctly on every direct write.

-- ── app_validate_plan_limits(): the schema `limits` jsonb doesn't have ──
--
-- Rejects anything that isn't a JSON object, any key outside the six this
-- codebase actually reads (five numeric limits + `features`), any
-- numeric limit that isn't null (unlimited) or a non-negative whole
-- number, and any `features` flag outside the three lib/entitlements
-- actually knows about or that isn't a plain true/false. Getting any of
-- this wrong today just means the mistyped limit silently enforces
-- nothing (app_plan_limits() reads a jsonb key that simply isn't there)
-- — this is what turns that into a rejected write instead.
create or replace function app_validate_plan_limits(p_limits jsonb)
returns void
language plpgsql
as $$
declare
  v_key text;
  v_feature_key text;
  v_numeric_keys text[] := array['max_users', 'max_branches', 'max_products', 'max_pos_terminals', 'storage_mb'];
  v_feature_keys text[] := array['advanced_reports', 'api_access', 'sms_notifications'];
begin
  if p_limits is null or jsonb_typeof(p_limits) <> 'object' then
    raise exception 'Plan limits must be a JSON object.' using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(p_limits) loop
    if v_key <> 'features' and not (v_key = any (v_numeric_keys)) then
      raise exception 'Unknown plan limit key: "%". Recognised keys are max_users, max_branches, max_products, max_pos_terminals, storage_mb, features.', v_key
        using errcode = '22023';
    end if;

    if v_key = any (v_numeric_keys) then
      if jsonb_typeof(p_limits -> v_key) <> 'null' and not (
        jsonb_typeof(p_limits -> v_key) = 'number'
        and (p_limits ->> v_key)::numeric >= 0
        and (p_limits ->> v_key)::numeric = floor((p_limits ->> v_key)::numeric)
      ) then
        raise exception 'Plan limit "%" must be null (unlimited) or a whole number of 0 or more.', v_key
          using errcode = '22023';
      end if;
    end if;
  end loop;

  if p_limits ? 'features' then
    if jsonb_typeof(p_limits -> 'features') <> 'object' then
      raise exception 'Plan limit "features" must be a JSON object of true/false flags.' using errcode = '22023';
    end if;

    for v_feature_key in select jsonb_object_keys(p_limits -> 'features') loop
      if not (v_feature_key = any (v_feature_keys)) then
        raise exception 'Unknown feature flag: "%". Recognised flags are advanced_reports, api_access, sms_notifications.', v_feature_key
          using errcode = '22023';
      end if;
      if jsonb_typeof(p_limits -> 'features' -> v_feature_key) <> 'boolean' then
        raise exception 'Feature flag "%" must be true or false.', v_feature_key using errcode = '22023';
      end if;
    end loop;
  end if;
end;
$$;

comment on function app_validate_plan_limits(jsonb) is
  'Validates a subscription_plans.limits jsonb value against the fixed set of keys lib/entitlements and app_enforce_limit() (0058) actually read — an unknown key or a malformed value is rejected rather than silently doing nothing. Called by admin_upsert_subscription_plan(); not meant to be called from application code directly.';

revoke all on function app_validate_plan_limits(jsonb) from public, anon, authenticated;

-- ── admin_upsert_subscription_plan(): create or edit a plan ──────────────
create or replace function admin_upsert_subscription_plan(
  p_id               uuid,
  p_slug             text,
  p_name             text,
  p_description      text,
  p_price_amount     numeric,
  p_currency_code    text,
  p_billing_interval text,
  p_limits           jsonb,
  p_is_active        boolean,
  p_sort_order       integer
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
  -- Normalized the same way v_slug is, and for the same reason: this
  -- function is reachable directly via supabase.rpc(), not only through
  -- app/admin/plans/actions.ts's own .toUpperCase() call, so the
  -- lowercase-rejected check below has to hold regardless of what
  -- actually calls it — never trust a caller to have already normalized
  -- its own input.
  v_currency_code text := upper(trim(coalesce(p_currency_code, '')));
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

  if p_id is null then
    v_action := 'platform.subscription_plan_created';

    insert into subscription_plans (
      slug, name, description, price_amount, currency_code, billing_interval, limits, is_active, sort_order
    ) values (
      v_slug, v_name, v_description, p_price_amount, v_currency_code, p_billing_interval, p_limits,
      coalesce(p_is_active, true), coalesce(p_sort_order, 0)
    )
    returning id into v_id;
  else
    v_action := 'platform.subscription_plan_updated';

    if not exists (select 1 from subscription_plans where id = p_id) then
      raise exception 'Plan not found' using errcode = 'P0002';
    end if;

    update subscription_plans set
      slug             = v_slug,
      name             = v_name,
      description      = v_description,
      price_amount     = p_price_amount,
      currency_code    = v_currency_code,
      billing_interval = p_billing_interval,
      limits           = p_limits,
      is_active        = coalesce(p_is_active, true),
      sort_order       = coalesce(p_sort_order, 0)
    where id = p_id;

    v_id := p_id;
  end if;

  perform log_audit_event(
    null, null, v_action, 'subscription_plan', v_id,
    jsonb_build_object(
      'slug', v_slug, 'name', v_name, 'price_amount', p_price_amount, 'currency_code', v_currency_code,
      'billing_interval', p_billing_interval, 'limits', p_limits, 'is_active', coalesce(p_is_active, true),
      'sort_order', coalesce(p_sort_order, 0)
    )
  );

  return v_id;
end;
$$;

comment on function admin_upsert_subscription_plan(uuid, text, text, text, numeric, text, text, jsonb, boolean, integer) is
  'Super-Admin-only create/update for the subscription_plans catalog (pricing, limits, name) — the write path behind /admin/plans. p_id null creates a new plan; a real p_id updates that row (rejecting an unknown one with P0002). Re-checks app_is_super_admin() itself, same as every other Super Admin write (bootstrap_super_admin 0035, admin_set_business_subscription 0058). Deleting a plan is deliberately not supported: retire one with p_is_active = false instead (subscription_plans_select, 0009, already hides an inactive plan from anyone but a Super Admin, and the assignment dropdown on /admin/businesses/[id] only lists active plans) — an actual delete would first need to decide what happens to any business still on that plan, which is out of scope here.';

revoke all on function admin_upsert_subscription_plan(uuid, text, text, text, numeric, text, text, jsonb, boolean, integer) from public, anon, authenticated;
grant execute on function admin_upsert_subscription_plan(uuid, text, text, text, numeric, text, text, jsonb, boolean, integer) to authenticated;