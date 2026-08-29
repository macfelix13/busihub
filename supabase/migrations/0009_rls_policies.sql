-- Busihub — 0009: Row Level Security
--
-- Tenant isolation is enforced here, not in application code (Section 4,
-- Section 49). Every tenant table gets RLS enabled; policies are written
-- as "what's allowed", everything else is denied by default. Several
-- tables deliberately have NO insert/update/delete policy for the
-- `authenticated` role at all — those tables are only ever mutated via a
-- SECURITY DEFINER function (0008, 0011) or the service-role client,
-- which is how we guarantee certain operations (business registration,
-- audit logging, billing state) stay atomic and cannot be spoofed.

-- ── businesses ───────────────────────────────────────────────────────────
alter table businesses enable row level security;

create policy businesses_select on businesses
  for select
  using (id = app_current_business_id() or app_is_super_admin());

create policy businesses_update on businesses
  for update
  using (app_has_permission(id, 'business.manage') or app_is_super_admin())
  with check (app_has_permission(id, 'business.manage') or app_is_super_admin());

-- No insert policy: businesses are created only via register_business() (0011).
-- No delete policy: closure is a status update, not a row deletion.

-- ── business_settings ────────────────────────────────────────────────────
alter table business_settings enable row level security;

create policy business_settings_select on business_settings
  for select
  using (business_id = app_current_business_id() or app_is_super_admin());

create policy business_settings_update on business_settings
  for update
  using (app_has_permission(business_id, 'business.manage') or app_is_super_admin())
  with check (app_has_permission(business_id, 'business.manage') or app_is_super_admin());

-- ── branches ─────────────────────────────────────────────────────────────
alter table branches enable row level security;

create policy branches_select on branches
  for select
  using (business_id = app_current_business_id() or app_is_super_admin());

create policy branches_insert on branches
  for insert
  with check (app_has_permission(business_id, 'branches.manage') or app_is_super_admin());

create policy branches_update on branches
  for update
  using (app_has_permission(business_id, 'branches.manage') or app_is_super_admin())
  with check (app_has_permission(business_id, 'branches.manage') or app_is_super_admin());

-- ── profiles ─────────────────────────────────────────────────────────────
alter table profiles enable row level security;

create policy profiles_select on profiles
  for select
  using (
    id = auth.uid()
    or business_id = app_current_business_id()
    or app_is_super_admin()
  );

create policy profiles_update on profiles
  for update
  using (id = auth.uid() or app_has_permission(business_id, 'users.manage') or app_is_super_admin())
  with check (id = auth.uid() or app_has_permission(business_id, 'users.manage') or app_is_super_admin());

-- No insert policy: profile rows are created server-side (service-role
-- client) as part of registration/staff-creation, immediately after the
-- corresponding auth.users row exists — see docs/AUTH.md.
-- No delete policy: deactivate via status, never delete (preserves audit
-- trail integrity — sales/audit rows reference profiles.id).

-- Guards against privilege escalation through the (necessarily permissive)
-- self-update policy above: is_super_admin, business_id, and pin_hash can
-- only change via a privileged server-side function that explicitly opts
-- in with the busihub.privileged_write session flag (see 0011).
create or replace function prevent_protected_profile_changes()
returns trigger
language plpgsql
as $$
begin
  if (new.is_super_admin is distinct from old.is_super_admin)
     or (new.business_id is distinct from old.business_id)
     or (new.pin_hash is distinct from old.pin_hash)
  then
    if coalesce(current_setting('busihub.privileged_write', true), 'off') <> 'on' then
      raise exception 'is_super_admin, business_id, and pin_hash can only be changed by a privileged server-side function'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger prevent_protected_profile_changes
  before update on profiles
  for each row execute function prevent_protected_profile_changes();

-- ── permissions (read-only catalog) ─────────────────────────────────────
alter table permissions enable row level security;

create policy permissions_select on permissions
  for select
  to authenticated
  using (true);

-- No insert/update/delete policy: the catalog changes only via migration.

-- ── roles ────────────────────────────────────────────────────────────────
alter table roles enable row level security;

create policy roles_select on roles
  for select
  using (business_id = app_current_business_id() or app_is_super_admin());

create policy roles_insert on roles
  for insert
  with check (app_has_permission(business_id, 'roles.manage') or app_is_super_admin());

create policy roles_update on roles
  for update
  using (app_has_permission(business_id, 'roles.manage') or app_is_super_admin())
  with check (app_has_permission(business_id, 'roles.manage') or app_is_super_admin());

create policy roles_delete on roles
  for delete
  using (
    (app_has_permission(business_id, 'roles.manage') or app_is_super_admin())
    and not is_system_role
  );

-- ── role_permissions ─────────────────────────────────────────────────────
alter table role_permissions enable row level security;

create policy role_permissions_select on role_permissions
  for select
  using (
    exists (
      select 1 from roles r
      where r.id = role_permissions.role_id
        and (r.business_id = app_current_business_id() or app_is_super_admin())
    )
  );

create policy role_permissions_insert on role_permissions
  for insert
  with check (
    exists (
      select 1 from roles r
      where r.id = role_permissions.role_id
        and (app_has_permission(r.business_id, 'roles.manage') or app_is_super_admin())
    )
  );

create policy role_permissions_delete on role_permissions
  for delete
  using (
    exists (
      select 1 from roles r
      where r.id = role_permissions.role_id
        and (app_has_permission(r.business_id, 'roles.manage') or app_is_super_admin())
    )
  );

-- ── user_branch_roles ────────────────────────────────────────────────────
alter table user_branch_roles enable row level security;

create policy user_branch_roles_select on user_branch_roles
  for select
  using (business_id = app_current_business_id() or app_is_super_admin());

create policy user_branch_roles_insert on user_branch_roles
  for insert
  with check (
    app_has_permission(business_id, 'users.manage')
    or app_has_permission(business_id, 'roles.manage')
    or app_is_super_admin()
  );

create policy user_branch_roles_delete on user_branch_roles
  for delete
  using (
    app_has_permission(business_id, 'users.manage')
    or app_has_permission(business_id, 'roles.manage')
    or app_is_super_admin()
  );

-- ── subscription_plans ───────────────────────────────────────────────────
alter table subscription_plans enable row level security;

create policy subscription_plans_select on subscription_plans
  for select
  using (is_active or app_is_super_admin());

create policy subscription_plans_write on subscription_plans
  for all
  using (app_is_super_admin())
  with check (app_is_super_admin());

-- ── business_subscriptions ───────────────────────────────────────────────
alter table business_subscriptions enable row level security;

create policy business_subscriptions_select on business_subscriptions
  for select
  using (business_id = app_current_business_id() or app_is_super_admin());

create policy business_subscriptions_write on business_subscriptions
  for all
  using (app_is_super_admin())
  with check (app_is_super_admin());

-- Regular billing lifecycle transitions (trial expiry, webhook-driven
-- status changes) are performed by scheduled/webhook server code using
-- the service-role client, which bypasses RLS entirely — the policy above
-- only covers a Super Admin acting through their own authenticated
-- session in the Super Admin UI.

-- ── audit_logs ───────────────────────────────────────────────────────────
alter table audit_logs enable row level security;

create policy audit_logs_select on audit_logs
  for select
  using (
    app_is_super_admin()
    or (business_id = app_current_business_id() and app_has_permission(business_id, 'audit.view'))
  );

-- No insert/update/delete policy for `authenticated`: all writes go
-- through log_audit_event() (0008), which is SECURITY DEFINER and so
-- bypasses RLS deliberately. Audit logs are immutable from the app's
-- point of view.

-- ── table-level grants ───────────────────────────────────────────────────
-- RLS restricts which ROWS a role can see/touch; it does not by itself
-- grant table access — Postgres still checks ordinary GRANT privileges
-- first. A managed Supabase project pre-configures roughly this same
-- baseline automatically for the public schema, but it is made explicit
-- here so this schema is correct on any plain Postgres instance too (this
-- is exactly what let us test these policies against a local Postgres
-- instance rather than only against a live Supabase project).
--
-- This is deliberately blanket and relies on RLS, not table-level grants,
-- to do the real authorization: a table with RLS enabled and no policy
-- for a given command denies that command regardless of the grant below
-- (e.g. `authenticated` has INSERT granted on audit_logs at the table
-- level, but 0009's policies define no INSERT policy for it, so the
-- insert is still refused — see the comment above).
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant usage, select on all sequences in schema public to authenticated;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant select on tables to anon;
