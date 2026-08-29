-- Busihub — 0011: business registration & related privileged functions
--
-- register_business() is what Section 5/6 of the brief calls for: signing
-- up creates the business, its main branch, the owner's profile, the
-- seeded system roles, the Owner's role assignment, and a trial
-- subscription — atomically, in one Postgres function, so a failure
-- partway through cannot leave an orphaned business or an ownerless
-- account. Call it via supabase.rpc('register_business', {...}) from the
-- server immediately after Supabase Auth creates the user.

create or replace function seed_default_roles_for_business(p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role_id uuid;
begin
  -- Owner: every permission in the catalog.
  insert into roles (business_id, name, description, is_system_role)
    values (p_business_id, 'Owner', 'Full access to everything in the business.', true)
    returning id into v_role_id;
  insert into role_permissions (role_id, permission_id)
    select v_role_id, id from permissions;

  -- Manager
  insert into roles (business_id, name, description, is_system_role)
    values (p_business_id, 'Manager', 'Day-to-day operational management.', true)
    returning id into v_role_id;
  insert into role_permissions (role_id, permission_id)
    select v_role_id, id from permissions
    where key in (
      'products.view','products.create','products.edit','products.archive','products.change_price',
      'inventory.view','inventory.adjust','inventory.receive','inventory.transfer',
      'suppliers.view','suppliers.manage','purchase_orders.create','purchase_orders.approve',
      'customers.view','customers.edit',
      'sales.process','sales.void','discounts.apply','sales.refund','sales.hold',
      'reports.view','reports.export','financial.view',
      'expenses.view','expenses.create','expenses.approve',
      'users.manage','audit.view','approvals.decide'
    );

  -- Cashier
  insert into roles (business_id, name, description, is_system_role)
    values (p_business_id, 'Cashier', 'Front-of-house sales.', true)
    returning id into v_role_id;
  insert into role_permissions (role_id, permission_id)
    select v_role_id, id from permissions
    where key in (
      'products.view','customers.view','customers.edit',
      'sales.process','sales.hold','discounts.apply','inventory.view'
    );

  -- Inventory Manager
  insert into roles (business_id, name, description, is_system_role)
    values (p_business_id, 'Inventory Manager', 'Stock, receiving, and purchasing.', true)
    returning id into v_role_id;
  insert into role_permissions (role_id, permission_id)
    select v_role_id, id from permissions
    where key in (
      'products.view','products.create','products.edit',
      'inventory.view','inventory.adjust','inventory.receive','inventory.transfer',
      'suppliers.view','suppliers.manage','purchase_orders.create','purchase_orders.approve',
      'reports.view'
    );

  -- Accountant
  insert into roles (business_id, name, description, is_system_role)
    values (p_business_id, 'Accountant', 'Financial records and reporting.', true)
    returning id into v_role_id;
  insert into role_permissions (role_id, permission_id)
    select v_role_id, id from permissions
    where key in (
      'financial.view','reports.view','reports.export',
      'expenses.view','expenses.create','expenses.approve',
      'customers.view','suppliers.view','audit.view'
    );

  -- Auditor: read-only oversight.
  insert into roles (business_id, name, description, is_system_role)
    values (p_business_id, 'Auditor', 'Read-only oversight.', true)
    returning id into v_role_id;
  insert into role_permissions (role_id, permission_id)
    select v_role_id, id from permissions
    where key in (
      'audit.view','reports.view','financial.view',
      'products.view','inventory.view','customers.view','suppliers.view'
    );
end;
$$;

revoke execute on function seed_default_roles_for_business(uuid) from public;

create or replace function register_business(
  p_business_name text,
  p_owner_first_name text,
  p_owner_last_name text default '',
  p_currency_code text default 'GHS',
  p_country_code text default 'GH',
  p_phone text default null
)
returns table (business_id uuid, branch_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business_id uuid;
  v_branch_id uuid;
  v_owner_role_id uuid;
  v_slug text;
  v_trial_plan_id uuid;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'register_business must be called by an authenticated user' using errcode = '28000';
  end if;

  if exists (select 1 from profiles where id = v_uid) then
    raise exception 'This account is already linked to a business' using errcode = '23505';
  end if;

  if coalesce(trim(p_business_name), '') = '' then
    raise exception 'Business name is required' using errcode = '22023';
  end if;

  v_slug := lower(regexp_replace(trim(p_business_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := trim(both '-' from v_slug);
  if v_slug = '' then
    v_slug := 'business';
  end if;
  while exists (select 1 from businesses where slug = v_slug) loop
    v_slug := v_slug || '-' || substr(md5(random()::text), 1, 5);
  end loop;

  insert into businesses (name, slug, currency_code, country_code, phone)
    values (trim(p_business_name), v_slug, coalesce(p_currency_code, 'GHS'), coalesce(p_country_code, 'GH'), p_phone)
    returning id into v_business_id;

  insert into business_settings (business_id) values (v_business_id);

  insert into branches (business_id, name, is_main)
    values (v_business_id, 'Main Branch', true)
    returning id into v_branch_id;

  insert into profiles (id, business_id, first_name, last_name, email)
    values (
      v_uid,
      v_business_id,
      trim(p_owner_first_name),
      coalesce(trim(p_owner_last_name), ''),
      (select email from auth.users where id = v_uid)
    );

  update businesses set created_by = v_uid where id = v_business_id;

  perform seed_default_roles_for_business(v_business_id);

  -- Qualified explicitly: this function's RETURNS TABLE (business_id, ...)
  -- creates an implicit OUT variable named business_id, which would
  -- otherwise shadow/collide with the roles.business_id column here.
  select id into v_owner_role_id from roles where roles.business_id = v_business_id and roles.name = 'Owner';

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_business_id, v_branch_id, v_uid, v_owner_role_id, v_uid);

  select id into v_trial_plan_id from subscription_plans where slug = 'trial';
  insert into business_subscriptions (business_id, plan_id, status, trial_ends_at, current_period_end)
    values (v_business_id, v_trial_plan_id, 'trialing', now() + interval '14 days', now() + interval '14 days');

  perform log_audit_event(
    v_business_id, v_branch_id, 'business.registered', 'business', v_business_id,
    jsonb_build_object('business_name', p_business_name)
  );

  return query select v_business_id, v_branch_id;
end;
$$;

comment on function register_business is
  'Atomically creates a business, its main branch, business_settings, the caller''s owner profile, the seeded system roles, the Owner role assignment, and a 14-day trial subscription. Called once, immediately after Supabase Auth creates the user. Raises if the calling account is already linked to a business.';

-- ── set_cashier_pin ──────────────────────────────────────────────────────
-- Stores a PIN hash computed server-side (bcrypt, in lib/auth/pin.ts) —
-- this function never sees or handles a plaintext PIN.
create or replace function set_cashier_pin(p_user_id uuid, p_pin_hash text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target_business_id uuid;
begin
  select business_id into v_target_business_id from profiles where id = p_user_id;

  if v_target_business_id is null then
    raise exception 'Target user not found or not linked to a business' using errcode = '22023';
  end if;

  if auth.uid() <> p_user_id
     and not app_has_permission(v_target_business_id, 'users.manage')
     and not app_is_super_admin()
  then
    raise exception 'Not authorized to set this user''s PIN' using errcode = '42501';
  end if;

  perform set_config('busihub.privileged_write', 'on', true);
  update profiles
    set pin_hash = p_pin_hash, pin_set_at = now(), pin_failed_attempts = 0, pin_locked_until = null
    where id = p_user_id;
  perform set_config('busihub.privileged_write', 'off', true);

  perform log_audit_event(v_target_business_id, null, 'user.pin_set', 'profile', p_user_id, '{}'::jsonb);
end;
$$;

comment on function set_cashier_pin is
  'Stores a pre-hashed cashier PIN. Caller must be the target user themself or hold users.manage. The pin_hash column is otherwise protected from UPDATE by the prevent_protected_profile_changes trigger (0009).';

-- ── grants ───────────────────────────────────────────────────────────────
-- RLS helper functions (0008) must be callable by the roles whose queries
-- invoke them inside USING/WITH CHECK clauses.
grant execute on function app_current_business_id() to authenticated, anon;
grant execute on function app_is_super_admin() to authenticated, anon;
grant execute on function app_has_permission(uuid, text) to authenticated, anon;
grant execute on function app_has_branch_permission(uuid, text) to authenticated, anon;
grant execute on function app_accessible_branch_ids(uuid) to authenticated;
grant execute on function log_audit_event(uuid, uuid, text, text, uuid, jsonb, inet, text) to authenticated;

grant execute on function register_business(text, text, text, text, text, text) to authenticated;
grant execute on function set_cashier_pin(uuid, text) to authenticated;
