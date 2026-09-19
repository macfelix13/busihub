-- Busihub — 0058: subscription entitlements enforcement (Phase 18)
--
-- The subscription schema (0006: subscription_plans, business_subscriptions)
-- and its seeded plan catalog (0010) have existed since the very first
-- migrations, but nothing has ever actually read them — every business,
-- regardless of plan or trial status, has had unlimited branches/products/
-- staff and never lost access when its trial ran out. This migration is
-- the enforcement half.
--
-- What this covers, all as HARD, server-side checks (never trusted from
-- the app layer alone — the app's own pre-checks in
-- app/(app)/branches/actions.ts etc. are a courtesy, not the real gate):
--   1. Branch/product/staff creation is capped by the business's own
--      plan.limits (max_branches/max_products/max_users), enforced by a
--      trigger on `branches` and inside create_product()/
--      invite_staff_member() respectively — the same three write paths
--      that already exist, not new endpoints.
--   2. A lapsed subscription (trial ended with no plan chosen, or
--      cancelled/expired/suspended by a Super Admin) locks the business
--      out of the app entirely, via app/(app)/layout.tsx — see that
--      file's own changelog entry, not this migration, for the UI side.
--   3. process_subscription_lifecycle(), called on a schedule by
--      app/api/cron/subscriptions (Vercel Cron, not a Supabase Edge
--      Function — see docs/ARCHITECTURE.md Section 9 for why that
--      contradicts an earlier design note), drives the one status
--      transition that needs no human decision: a trial running out.
--   4. admin_set_business_subscription() lets a Super Admin put a
--      business on a real plan/status by hand, since real recurring
--      billing (charging a business through Paystack every month) is
--      deliberately NOT part of this phase — see the note below.
--
-- Deliberately NOT covered by this migration, each for a documented
-- reason rather than by oversight:
--   - Real payment collection. Nothing in this codebase charges a
--     business anything today — Paystack is wired up per-business so a
--     SHOP can accept mobile money from ITS OWN customers (0022), not so
--     Busihub can bill the shop. Wiring actual recurring billing (a
--     plan-selection/checkout UI, Paystack's Plans/Subscriptions API,
--     webhook handling for invoice.payment_failed etc., proration) is a
--     project on the scale of the original Payments phase (10) by
--     itself. Until it exists, a business's plan/status is set by a
--     Super Admin by hand (this migration's admin_set_business_
--     subscription()) after being paid some other way — exactly the
--     kind of "real, not fake" partial completion the project brief
--     calls for: what's built here actually enforces limits and actually
--     locks out a lapsed account, it just doesn't move money yet.
--   - `limits.storage_mb`: nothing in this codebase counts how much
--     Storage a business is using (product photos, service-provider
--     photos), so there is no live count to compare it against. Adding
--     one is a separate, real piece of work, not a one-line check.
--   - `limits.max_pos_terminals`: there is no "POS terminal" row
--     anywhere in this schema — a cashier signs into the till with a PIN
--     from any device, and nothing registers which physical devices are
--     in use. Enforcing a device count without a device concept to count
--     would mean inventing one just to satisfy this migration, which is
--     exactly the kind of fabricated-just-to-look-done work the project
--     brief warns against.
--   - `limits.features.*` (advanced_reports/api_access/sms_notifications):
--     the Reports phase (14) never drew a line between a "basic" and an
--     "advanced" report, and there is no API surface or SMS integration
--     to gate in the first place (see docs/ARCHITECTURE.md Phase 15).
--     Gating something that doesn't yet have a basic/advanced split, or
--     that doesn't exist at all, would mean inventing the split first —
--     out of scope for an enforcement pass.
--   - Reactivating an existing INACTIVE branch, or un-archiving an
--     existing product, past the plan's limit. The trigger/check below
--     only fires on a brand-new row (INSERT) — the primary abuse vector
--     this phase closes is unbounded creation, not every path back to
--     "active" for something that already existed under an earlier,
--     higher-limit plan. Documented here rather than silently assumed.
--   - Automatically moving a manually-assigned `active` subscription to
--     `past_due` once its current_period_end passes. With no real
--     billing, current_period_end on a hand-assigned plan is an
--     administrative marker, not a hard deadline the business agreed to
--     be billed against — auto-locking a real, paying business out
--     because whoever set their plan forgot to bump a date is a worse
--     failure mode than under-enforcing here. A Super Admin moves a
--     business to past_due/suspended by hand when that is genuinely
--     warranted. The one transition process_subscription_lifecycle()
--     DOES automate — a trial simply running out — needs no such human
--     judgment call.

-- ── grace-period tracking ──────────────────────────────────────────────

alter table business_subscriptions add column past_due_since timestamptz;

comment on column business_subscriptions.past_due_since is
  'When this subscription most recently entered past_due — either automatically (a trial''s trial_ends_at passed, see process_subscription_lifecycle()) or by a Super Admin''s own hand (admin_set_business_subscription()). Cleared whenever status moves to anything other than past_due. process_subscription_lifecycle() moves a business from past_due to expired once past_due_since is more than the grace period (3 days) old, regardless of which path set it.';

-- ── entitlement-limit helpers ─────────────────────────────────────────────

-- SQL, not plpgsql: a single read, no branching, safe to call from inside
-- another function's WHERE/expression context as well as standalone.
create or replace function app_plan_limits(p_business_id uuid)
returns jsonb
language sql
stable
as $$
  select sp.limits
  from business_subscriptions bs
  join subscription_plans sp on sp.id = bs.plan_id
  where bs.business_id = p_business_id;
$$;

comment on function app_plan_limits(uuid) is
  'The current plan''s limits jsonb for a business ({"max_users": 5, "max_branches": 1, ...} — see 0010''s seed data), or null if the business has no subscription row at all (should not happen past register_business(), but callers must treat null as "nothing to enforce", never as zero).';

create or replace function app_enforce_limit(
  p_business_id uuid,
  p_limit_key text,
  p_current_count bigint,
  p_noun text
)
returns void
language plpgsql
as $$
declare
  v_limits jsonb;
  v_limit_value integer;
begin
  v_limits := app_plan_limits(p_business_id);

  -- No subscription row / no limits jsonb: a data gap, not a signal to
  -- block. Every real business has one from register_business() onward;
  -- refusing to create a branch/product/staff account over a missing row
  -- would be a worse bug than the one this migration is fixing.
  if v_limits is null then
    return;
  end if;

  -- A jsonb `null` value (Enterprise's "unlimited" convention — see
  -- 0010's seed data, e.g. "max_branches": null) and a missing key both
  -- come back as SQL NULL from ->>, and both mean unlimited here.
  v_limit_value := nullif(v_limits ->> p_limit_key, '')::integer;
  if v_limit_value is null then
    return;
  end if;

  if p_current_count >= v_limit_value then
    raise exception 'You''ve reached this plan''s limit of % %. Contact Busihub support to upgrade your plan.', v_limit_value, p_noun
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function app_enforce_limit(uuid, text, bigint, text) is
  'Raises a friendly, already-user-facing P0001 error (same convention as create_product''s other business-rule checks) if p_current_count has already reached or passed the named limit key on the business''s current plan. A no-op for an unlimited (jsonb null) or missing limit, and for a business with no subscription row at all (see app_plan_limits()). Called from the one BEFORE INSERT trigger (branches) and from inside the two SECURITY DEFINER functions (create_product, invite_staff_member) that are the real write path for the other two limited resources — never relied on as an app-layer-only check.';

-- ── branches: max_branches ─────────────────────────────────────────────

create or replace function enforce_branch_limit()
returns trigger
language plpgsql
as $$
declare
  v_count bigint;
begin
  select count(*) into v_count from branches where business_id = new.business_id and status = 'active';
  perform app_enforce_limit(new.business_id, 'max_branches', v_count, 'branches');
  return new;
end;
$$;

comment on function enforce_branch_limit() is
  'BEFORE INSERT trigger: blocks creating a new branch once the business already has plan.limits.max_branches active ones. Fires for every INSERT into branches, including the very first branch a brand-new business gets from register_business() — safe, since app_enforce_limit() is a no-op until a subscription row exists and every seeded plan allows at least 1.';

create trigger enforce_branch_limit_trigger
  before insert on branches
  for each row execute function enforce_branch_limit();

-- ── create_product(): max_products ────────────────────────────────────
--
-- Same signature as 0046 (business_id, name, description, category_id,
-- unit_of_measure, tax_category, variant_option_names, variants,
-- branch_id, type, duration_minutes, photo_url) — create or replace only,
-- no drop/re-create needed since no parameter is added or removed this
-- time (see 0046's own header for why that trap matters when a parameter
-- IS added). One count covers both products and services — the seed
-- data (0010) has no separate max_services key, so a business's product
-- and service catalog share one limit, matching how they already share
-- one table and one permission set (products.*, since 0040).

create or replace function create_product(
  p_business_id uuid,
  p_name text,
  p_description text,
  p_category_id uuid,
  p_unit_of_measure text,
  p_tax_category text,
  p_variant_option_names text[],
  p_variants jsonb,
  p_branch_id uuid default null,
  p_type text default 'product',
  p_duration_minutes integer default null,
  p_photo_url text default null
)
returns uuid
language plpgsql
as $$
declare
  v_product_id uuid;
  v_variant    jsonb;
  v_variant_id uuid;
  v_has_variants boolean;
  v_opening    numeric(14, 3);
  v_any_stock  boolean := false;
  v_duration   integer;
begin
  if p_type not in ('product', 'service') then
    raise exception 'Unknown product type' using errcode = '22023';
  end if;

  if p_variants is null or jsonb_array_length(p_variants) < 1 then
    raise exception 'At least one variant is required' using errcode = 'P0001';
  end if;

  if p_category_id is not null
     and not exists (select 1 from categories where id = p_category_id and business_id = p_business_id) then
    raise exception 'Invalid category_id: category not found' using errcode = 'P0002';
  end if;

  if p_type = 'product' then
    for v_variant in select * from jsonb_array_elements(p_variants)
    loop
      if coalesce(jsonb_typeof(v_variant -> 'opening_stock'), 'null') <> 'null'
         and coalesce((v_variant ->> 'opening_stock')::numeric, 0) <> 0 then
        v_any_stock := true;
      end if;
    end loop;
  end if;

  if v_any_stock then
    if p_branch_id is null then
      raise exception 'Choose which branch the opening stock is at' using errcode = 'P0001';
    end if;
    if not exists (select 1 from branches where id = p_branch_id and business_id = p_business_id) then
      raise exception 'Invalid branch_id: branch not found' using errcode = 'P0002';
    end if;
  end if;

  if p_type = 'service' then
    if p_duration_minutes is not null and p_duration_minutes <= 0 then
      raise exception 'Duration must be a positive number of minutes' using errcode = 'P0001';
    end if;
    v_duration := p_duration_minutes;
  else
    v_duration := null;
  end if;

  -- Entitlement check, last, so every other validation error (bad
  -- category/branch, malformed variants) still gets its own specific
  -- message rather than being masked by a limit error.
  perform app_enforce_limit(
    p_business_id,
    'max_products',
    (select count(*) from products where business_id = p_business_id and status = 'active'),
    'products'
  );

  v_has_variants := coalesce(array_length(p_variant_option_names, 1), 0) > 0;

  insert into products (
    business_id, name, description, category_id, unit_of_measure, tax_category,
    has_variants, variant_option_names, type, duration_minutes, photo_url, created_by
  )
  values (
    p_business_id, p_name, nullif(p_description, ''), p_category_id,
    p_unit_of_measure, p_tax_category, v_has_variants, p_variant_option_names, p_type, v_duration,
    p_photo_url, auth.uid()
  )
  returning id into v_product_id;

  for v_variant in select * from jsonb_array_elements(p_variants)
  loop
    insert into product_variants (
      product_id, sku, barcode, variant_options, cost_price, selling_price, is_default
    )
    values (
      v_product_id,
      nullif(v_variant ->> 'sku', ''),
      nullif(v_variant ->> 'barcode', ''),
      coalesce(v_variant -> 'variant_options', '{}'::jsonb),
      coalesce((v_variant ->> 'cost_price')::numeric, 0),
      (v_variant ->> 'selling_price')::numeric,
      not v_has_variants
    )
    returning id into v_variant_id;

    if p_type = 'product' then
      v_opening := case
        when coalesce(jsonb_typeof(v_variant -> 'opening_stock'), 'null') = 'null' then 0
        else coalesce((v_variant ->> 'opening_stock')::numeric, 0)
      end;

      if v_opening < 0 then
        raise exception 'Opening stock cannot be negative' using errcode = 'P0001';
      end if;

      if v_opening > 0 then
        insert into inventory_movements (
          business_id, branch_id, variant_id, quantity_delta, reason,
          reference_type, reference_id, note
        )
        values (
          '00000000-0000-0000-0000-000000000000', -- replaced by the trigger
          p_branch_id, v_variant_id, v_opening, 'receive',
          'product', v_product_id, 'Opening stock'
        );
      end if;
    end if;
  end loop;

  return v_product_id;
end;
$$;

-- ── invite_staff_member(): max_users ───────────────────────────────────
--
-- Same 6-argument signature as 0036 — create or replace only. Counts
-- profiles with status='active' only: a deactivated colleague (0036's
-- own set_staff_status) frees their seat, same as a shop that lets
-- someone go being able to hire a replacement without first deleting the
-- old account.

create or replace function invite_staff_member(
  p_invited_user_id uuid,
  p_branch_id uuid,
  p_role_id uuid,
  p_first_name text,
  p_last_name text,
  p_email text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_business_id uuid;
  v_role_name text;
  v_role_is_system boolean;
begin
  select business_id into v_business_id from profiles where id = v_caller;
  if v_business_id is null then
    raise exception 'Caller is not linked to a business' using errcode = '42501';
  end if;

  if not app_has_permission(v_business_id, 'users.manage') and not app_is_super_admin() then
    raise exception 'Not authorized to add staff' using errcode = '42501';
  end if;

  if p_invited_user_id is null or not exists (select 1 from auth.users where id = p_invited_user_id) then
    raise exception 'Invited account not found' using errcode = '22023';
  end if;

  if exists (select 1 from profiles where id = p_invited_user_id) then
    raise exception 'This account already belongs to a business' using errcode = '23505';
  end if;

  if not exists (select 1 from branches where id = p_branch_id and business_id = v_business_id) then
    raise exception 'Branch does not belong to this business' using errcode = '22023';
  end if;

  select name, is_system_role into v_role_name, v_role_is_system
  from roles where id = p_role_id and business_id = v_business_id;

  if v_role_name is null then
    raise exception 'Role does not belong to this business' using errcode = '22023';
  end if;

  if v_role_name = 'Owner' and v_role_is_system
     and not app_has_permission(v_business_id, 'business.manage')
     and not app_is_super_admin()
  then
    raise exception 'Only an Owner can grant the Owner role' using errcode = '42501';
  end if;

  if coalesce(trim(p_first_name), '') = '' then
    raise exception 'First name is required' using errcode = '22023';
  end if;

  -- Entitlement check, last, so every other validation error above still
  -- gets its own specific message rather than being masked by a limit
  -- error — same ordering choice as create_product() above. The Auth
  -- Admin API call that created p_invited_user_id's auth.users row has
  -- already happened by the time this runs (see
  -- app/(app)/settings/staff/actions.ts's own comment on why that's two
  -- steps) — a limit hit here leaves that same safe-orphan state the
  -- action's rpcError branch already documents, not a new failure mode.
  perform app_enforce_limit(
    v_business_id,
    'max_users',
    (select count(*) from profiles where business_id = v_business_id and status = 'active'),
    'staff accounts'
  );

  insert into profiles (id, business_id, first_name, last_name, email)
    values (p_invited_user_id, v_business_id, trim(p_first_name), coalesce(trim(p_last_name), ''), p_email);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_business_id, p_branch_id, p_invited_user_id, p_role_id, v_caller);

  perform log_audit_event(
    v_business_id, p_branch_id, 'user.invited', 'profile', p_invited_user_id,
    jsonb_build_object('email', p_email, 'role_name', v_role_name)
  );
end;
$$;

-- ── status lifecycle ─────────────────────────────────────────────────────

create or replace function process_subscription_lifecycle()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_grace_days constant integer := 3;
  v_trial_ended_count integer := 0;
  v_grace_expired_count integer := 0;
  v_cancelled_count integer := 0;
  r record;
begin
  -- 1) A trial ran out with no plan chosen: trialing -> past_due. Reusing
  -- past_due (rather than jumping straight to expired) gives a business
  -- a grace window and something for app/(app)/layout.tsx to show a
  -- banner about, without yet locking anyone out.
  for r in
    select bs.business_id
    from business_subscriptions bs
    where bs.status = 'trialing'
      and bs.trial_ends_at is not null
      and bs.trial_ends_at < now()
  loop
    update business_subscriptions
      set status = 'past_due', past_due_since = now(), updated_at = now()
      where business_subscriptions.business_id = r.business_id;
    perform log_audit_event(
      r.business_id, null, 'platform.subscription_trial_ended', 'business_subscription', r.business_id,
      jsonb_build_object('from_status', 'trialing', 'to_status', 'past_due', 'grace_days', v_grace_days)
    );
    v_trial_ended_count := v_trial_ended_count + 1;
  end loop;

  -- 2) The grace window itself ran out with no resolution: past_due ->
  -- expired. Anchored on past_due_since, not trial_ends_at, so this
  -- covers a Super-Admin-set past_due (admin_set_business_subscription())
  -- exactly the same way it covers one this function itself just set
  -- above (which will not re-match in the same run: past_due_since was
  -- just set to now()).
  for r in
    select bs.business_id
    from business_subscriptions bs
    where bs.status = 'past_due'
      and bs.past_due_since is not null
      and bs.past_due_since < now() - (v_grace_days || ' days')::interval
  loop
    update business_subscriptions
      set status = 'expired', updated_at = now()
      where business_subscriptions.business_id = r.business_id;
    perform log_audit_event(
      r.business_id, null, 'platform.subscription_expired', 'business_subscription', r.business_id,
      jsonb_build_object('from_status', 'past_due', 'to_status', 'expired')
    );
    v_grace_expired_count := v_grace_expired_count + 1;
  end loop;

  -- 3) A cancellation a Super Admin already scheduled has arrived at its
  -- period end: active -> cancelled. Only ever fires for a row someone
  -- explicitly flagged cancel_at_period_end on — this function never
  -- sets that flag itself.
  for r in
    select bs.business_id
    from business_subscriptions bs
    where bs.status = 'active'
      and bs.cancel_at_period_end
      and bs.current_period_end is not null
      and bs.current_period_end < now()
  loop
    update business_subscriptions
      set status = 'cancelled', updated_at = now()
      where business_subscriptions.business_id = r.business_id;
    perform log_audit_event(
      r.business_id, null, 'platform.subscription_cancelled', 'business_subscription', r.business_id,
      jsonb_build_object('from_status', 'active', 'to_status', 'cancelled')
    );
    v_cancelled_count := v_cancelled_count + 1;
  end loop;

  return jsonb_build_object(
    'trial_ended', v_trial_ended_count,
    'grace_expired', v_grace_expired_count,
    'cancelled_at_period_end', v_cancelled_count,
    'ran_at', now()
  );
end;
$$;

comment on function process_subscription_lifecycle() is
  'Called on a schedule by app/api/cron/subscriptions (Vercel Cron) using the service-role client — see this migration''s file header for why that is Vercel Cron and not a Supabase Edge Function. Drives exactly one unattended transition (a trial running out, and its grace period after that) plus fulfilling a cancellation a Super Admin already scheduled; every other status change is a deliberate, logged, human decision via admin_set_business_subscription(). Returns a jsonb summary of how many rows it moved, for the cron route to report.';

revoke all on function process_subscription_lifecycle() from public, anon, authenticated;
grant execute on function process_subscription_lifecycle() to service_role;

-- ── Super Admin: manual plan/status assignment ────────────────────────────

create or replace function admin_set_business_subscription(
  p_business_id uuid,
  p_plan_slug text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan_id uuid;
  v_old_status subscription_status;
  v_new_status subscription_status;
  v_past_due_since timestamptz;
begin
  if not app_is_super_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not exists (select 1 from businesses where id = p_business_id) then
    raise exception 'Business not found' using errcode = 'P0002';
  end if;

  select id into v_plan_id from subscription_plans where slug = p_plan_slug and is_active;
  if v_plan_id is null then
    raise exception 'Unknown or inactive plan: %', p_plan_slug using errcode = 'P0002';
  end if;

  if not (p_status = any (enum_range(null::subscription_status)::text[])) then
    raise exception 'Unknown subscription status: %', p_status using errcode = '22023';
  end if;
  v_new_status := p_status::subscription_status;

  select status, past_due_since into v_old_status, v_past_due_since
  from business_subscriptions where business_id = p_business_id;

  if v_old_status is null then
    raise exception 'This business has no subscription row to update' using errcode = 'P0002';
  end if;

  -- Grace-period bookkeeping mirrors process_subscription_lifecycle()'s
  -- own rule: entering past_due (from anything else) starts the clock;
  -- leaving it clears the clock; staying in it (not the case here, since
  -- this always writes a fresh row, but kept for clarity) leaves it be.
  if v_new_status = 'past_due' and v_old_status <> 'past_due' then
    v_past_due_since := now();
  elsif v_new_status <> 'past_due' then
    v_past_due_since := null;
  end if;

  update business_subscriptions
    set plan_id = v_plan_id,
        status = v_new_status,
        -- A fresh billing period starts now only when this update is
        -- what's making the business active — re-saving an already-
        -- active business with the same status leaves its existing
        -- period_start alone.
        current_period_start = case when v_new_status = 'active' and v_old_status <> 'active' then now() else current_period_start end,
        current_period_end = p_current_period_end,
        cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
        past_due_since = v_past_due_since,
        updated_at = now()
    where business_id = p_business_id;

  perform log_audit_event(
    p_business_id, null, 'platform.subscription_updated', 'business_subscription', p_business_id,
    jsonb_build_object('plan_slug', p_plan_slug, 'from_status', v_old_status, 'to_status', v_new_status)
  );
end;
$$;

comment on function admin_set_business_subscription(uuid, text, text, timestamptz, boolean) is
  'Super-Admin-only, hand-operated stand-in for real recurring billing (see this migration''s file header) — puts a business on a given plan/status after it has been paid some other way. Re-checks app_is_super_admin() itself rather than trusting the console UI, same as every other Super Admin write (bootstrap_super_admin, 0035).';

revoke all on function admin_set_business_subscription(uuid, text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function admin_set_business_subscription(uuid, text, text, timestamptz, boolean) to authenticated;