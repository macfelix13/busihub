-- Busihub — 0054: custom staff roles (Settings → Staff → Roles)
--
-- The RBAC schema (0005), its RLS policies (0009), and the default role
-- seed (0011) have supported per-business custom roles since early in
-- the project — roles.manage already gates roles_insert/_update/_delete
-- and role_permissions_insert/_delete for ANY role, system or custom
-- (0009's own comments say so explicitly), and migration 0044 already
-- assumed a "Settings → Staff → Roles" screen existed ("...via Settings →
-- Staff → Roles, which already lists every permission in the catalog").
-- This migration adds the one piece that was actually missing: a safe
-- way to replace a role's full permission set in one call, plus two
-- DB-level guardrails that no amount of careful application code should
-- be the only thing standing between a well-meaning Owner and a broken
-- business:
--
--  1. app/(app)/settings/staff/[id]/page.tsx's "is this the last active
--     Owner" safeguard is a literal `.eq("roles.name", "Owner")` string
--     match, not an is_system_role flag alone — renaming the built-in
--     Owner role would silently break that check for every business that
--     ever renamed it. protect_system_role_identity() below blocks
--     renaming (or un-flagging) any system role outright, at the table
--     level, so this can't be bypassed by a UI bug or a direct API call.
--  2. user_branch_roles.role_id references roles(id) on delete cascade —
--     deleting a role that is currently assigned to staff would silently
--     orphan (delete) those assignments with no error at all.
--     prevent_assigned_role_delete() blocks that at the table level too.
--     (A *system* role is already unconditionally protected from
--     deletion by 0009's roles_delete policy; this covers the *custom*
--     role case that policy does not, since a custom role is deletable
--     by design.)
--
-- set_role_permissions() itself mirrors update_staff_role()'s (0036)
-- established pattern for a compound, safety-critical mutation:
-- SECURITY DEFINER with an explicit internal app_has_permission() check
-- that RAISES a real exception, rather than SECURITY INVOKER relying on
-- RLS to silently affect 0 rows on an unauthorized call — a caller
-- deserves a clean, specific error, not a mysterious no-op.

-- ── guardrail 1: a system role's name/is_system_role can never change ────

create or replace function protect_system_role_identity()
returns trigger
language plpgsql
as $$
begin
  if old.is_system_role and (new.name is distinct from old.name or new.is_system_role is distinct from old.is_system_role) then
    raise exception 'Built-in roles can''t be renamed or converted to a custom role.' using errcode = '22023';
  end if;
  return new;
end;
$$;

comment on function protect_system_role_identity is
  'Blocks renaming a system role (or flipping is_system_role) at the table level. Protects app/(app)/settings/staff/[id]/page.tsx''s .eq("roles.name", "Owner") last-active-Owner check, which would silently stop working the moment a business renamed its Owner role.';

create trigger protect_system_role_identity
  before update on roles
  for each row execute function protect_system_role_identity();

-- ── guardrail 2: a role currently assigned to staff can't be deleted ─────

create or replace function prevent_assigned_role_delete()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from user_branch_roles where role_id = old.id) then
    raise exception 'This role is assigned to one or more staff members. Reassign them first.' using errcode = '23503';
  end if;
  return old;
end;
$$;

comment on function prevent_assigned_role_delete is
  'Blocks deleting a role that user_branch_roles still references, so the on delete cascade on user_branch_roles.role_id can never silently orphan a staff member''s access. System roles are already unconditionally protected by 0009''s roles_delete RLS policy; this covers custom roles, which are deletable by design.';

create trigger prevent_assigned_role_delete
  before delete on roles
  for each row execute function prevent_assigned_role_delete();

-- ── set_role_permissions(): replace a role's entire permission set ───────

create or replace function set_role_permissions(p_role_id uuid, p_permission_keys text[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_business_id uuid;
  v_role_business_id uuid;
  v_role_name text;
  v_role_is_system boolean;
  v_keys text[] := coalesce(p_permission_keys, array[]::text[]);
  v_unknown_key text;
begin
  select business_id into v_business_id from profiles where id = v_caller;
  if v_business_id is null then
    raise exception 'Caller is not linked to a business' using errcode = '42501';
  end if;

  if not app_has_permission(v_business_id, 'roles.manage') and not app_is_super_admin() then
    raise exception 'Not authorized to manage roles' using errcode = '42501';
  end if;

  select business_id, name, is_system_role
    into v_role_business_id, v_role_name, v_role_is_system
    from roles where id = p_role_id;

  if v_role_business_id is distinct from v_business_id then
    raise exception 'Role not found' using errcode = 'P0002';
  end if;

  -- The Owner system role must always keep the two permissions that let
  -- SOMEONE keep running the business at all: without roles.manage no one
  -- could ever fix a bad permission change (including this one), and
  -- without business.manage no one could re-grant Owner to a colleague if
  -- the last Owner account were ever lost. Every other built-in role, and
  -- every custom role, can be edited down to nothing at all.
  if v_role_is_system and v_role_name = 'Owner' then
    if not ('roles.manage' = any(v_keys)) or not ('business.manage' = any(v_keys)) then
      raise exception 'The Owner role must always keep "Manage roles" and "Manage business settings".' using errcode = '22023';
    end if;
  end if;

  select k.key into v_unknown_key
  from unnest(v_keys) as k(key)
  where not exists (select 1 from permissions p where p.key = k.key)
  limit 1;

  if v_unknown_key is not null then
    raise exception 'Unknown permission: %', v_unknown_key using errcode = '22023';
  end if;

  delete from role_permissions where role_id = p_role_id;

  insert into role_permissions (role_id, permission_id)
  select p_role_id, p.id from permissions p where p.key = any(v_keys);

  perform log_audit_event(
    v_business_id, null, 'role.permissions_updated', 'role', p_role_id,
    jsonb_build_object('permission_count', coalesce(array_length(v_keys, 1), 0))
  );
end;
$$;

comment on function set_role_permissions is
  'Replaces a role''s entire permission set in one call. SECURITY DEFINER with an explicit roles.manage check (mirrors update_staff_role, 0036) rather than relying on RLS alone, so an unauthorized or cross-tenant call gets a clean error instead of a silent no-op. Refuses to strip the Owner system role of roles.manage/business.manage.';

revoke all on function set_role_permissions(uuid, text[]) from public;
grant execute on function set_role_permissions(uuid, text[]) to authenticated;