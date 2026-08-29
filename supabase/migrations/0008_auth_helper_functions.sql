-- Busihub — 0008: RLS helper functions
--
-- SECURITY DEFINER with a locked-down search_path is the standard safe
-- pattern for RLS helpers: they run with the function owner's privileges
-- (bypassing RLS on the tables they read internally) so that checking
-- "does this user have permission X" doesn't itself get blocked by RLS on
-- user_branch_roles/role_permissions, while still only ever *returning* a
-- boolean/id derived from auth.uid() — never exposing arbitrary rows.

create or replace function app_current_business_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select business_id from profiles where id = auth.uid();
$$;

create or replace function app_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select is_super_admin from profiles where id = auth.uid()),
    false
  );
$$;

-- Business-level permission check: does the caller hold, at ANY branch of
-- p_business_id, a role granting p_permission_key? Used for business-wide
-- actions (managing branches, users, roles, settings, reports).
create or replace function app_has_permission(p_business_id uuid, p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    app_is_super_admin()
    or exists (
      select 1
      from user_branch_roles ubr
      join role_permissions rp on rp.role_id = ubr.role_id
      join permissions p on p.id = rp.permission_id
      where ubr.user_id = auth.uid()
        and ubr.business_id = p_business_id
        and p.key = p_permission_key
    );
$$;

-- Branch-level permission check, for operational tables (POS, inventory,
-- sales, ...) introduced in later phases. Included now so those phases
-- only need to add policies, not new helper functions.
create or replace function app_has_branch_permission(p_branch_id uuid, p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    app_is_super_admin()
    or exists (
      select 1
      from user_branch_roles ubr
      join role_permissions rp on rp.role_id = ubr.role_id
      join permissions p on p.id = rp.permission_id
      where ubr.user_id = auth.uid()
        and ubr.branch_id = p_branch_id
        and p.key = p_permission_key
    );
$$;

-- All branch ids the current user holds any role at, within a business.
create or replace function app_accessible_branch_ids(p_business_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select branch_id from user_branch_roles
  where user_id = auth.uid() and business_id = p_business_id;
$$;

-- Records an audit log entry. SECURITY DEFINER so it can insert into
-- audit_logs even though no direct INSERT policy is granted to
-- authenticated users (0009) — this function is the *only* sanctioned
-- write path, called from server-side code after every permission-gated
-- mutation.
create or replace function log_audit_event(
  p_business_id   uuid,
  p_branch_id     uuid,
  p_action        text,
  p_resource_type text,
  p_resource_id   uuid,
  p_metadata      jsonb default '{}'::jsonb,
  p_ip_address    inet default null,
  p_user_agent    text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into audit_logs (
    business_id, branch_id, actor_user_id, action, resource_type,
    resource_id, metadata, ip_address, user_agent
  ) values (
    p_business_id, p_branch_id, auth.uid(), p_action, p_resource_type,
    p_resource_id, coalesce(p_metadata, '{}'::jsonb), p_ip_address, p_user_agent
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function log_audit_event is
  'The only sanctioned write path into audit_logs. Called from server-side application code (never the browser directly) after every permission-gated mutation, so authorization and logging cannot drift apart.';
