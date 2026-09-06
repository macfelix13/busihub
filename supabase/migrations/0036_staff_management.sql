-- Busihub — 0036: staff management (invite, role change, activate/deactivate)
--
-- The RBAC schema (0005/0011) and the users.manage/audit.view permission
-- keys have existed since the earliest phases, but nothing could ever
-- actually add a colleague to a business — profiles has "No insert
-- policy: profile rows are created server-side... as part of
-- registration/staff-creation" (0009's own comment), and staff-creation
-- was the half of that sentence nothing had built yet. This migration
-- builds it: three SECURITY DEFINER functions, each re-deriving the
-- caller's own business_id from their own profile (never accepting a
-- business_id argument from the client — Section 7/49), so there is no
-- way to act on a business other than the caller's own no matter what a
-- tampered request claims.
--
-- Deliberate escalation guard: seed_default_roles_for_business (0011)
-- gives Manager users.manage but not business.manage or roles.manage.
-- Without a check here, a Manager could invite a brand-new colleague and
-- directly hand them the Owner role — instantly outranking the Manager
-- who created them. Granting (or moving someone into) the Owner role
-- therefore additionally requires business.manage, which only Owner
-- holds by default. Assigning any other role only requires users.manage,
-- same as before.
--
-- Deliberate lockout guard: both update_staff_role and set_staff_status
-- refuse a change that would leave the business with zero active Owner-
-- role holders, and both refuse to let a user act on their own row (self-
-- service role/status changes go through other paths, not this one) —
-- one manager fat-fingering their own account should never be able to
-- strand a whole business with no one who can undo it.

-- Shared guard, used by both update_staff_role and set_staff_status:
-- raises unless at least one OTHER active Owner-role holder would remain
-- in v_business_id after acting on p_target_user_id.
create or replace function assert_owner_remains_after(p_business_id uuid, p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_remaining_owners integer;
begin
  select count(*) into v_remaining_owners
  from profiles p
  where p.business_id = p_business_id
    and p.status = 'active'
    and p.id <> p_target_user_id
    and exists (
      select 1 from user_branch_roles ubr
      join roles r on r.id = ubr.role_id
      where ubr.user_id = p.id and r.business_id = p_business_id
        and r.name = 'Owner' and r.is_system_role
    );

  if v_remaining_owners = 0 then
    raise exception 'This would leave the business with no active Owner. Assign Owner to someone else first.'
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function assert_owner_remains_after(uuid, uuid) from public;

-- ── invite_staff_member ──────────────────────────────────────────────────
-- Called immediately after the inviting server action creates the
-- auth.users row via Supabase Admin's inviteUserByEmail() (that part
-- needs the service-role client — Postgres has no access to Auth's admin
-- API — so it happens in application code; this function does everything
-- from there on, atomically, checked against the CALLER's own session).
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

comment on function invite_staff_member is
  'Second half of the staff-invite flow: creates the profile + branch/role assignment for an auth.users row that Supabase Admin''s inviteUserByEmail() (service-role, application code) already created. Caller''s own business_id is looked up server-side, never accepted as an argument. Granting the Owner role additionally requires business.manage.';

revoke all on function invite_staff_member(uuid, uuid, uuid, text, text, text) from public;
grant execute on function invite_staff_member(uuid, uuid, uuid, text, text, text) to authenticated;

-- ── update_staff_role ────────────────────────────────────────────────────
-- One role per person per branch, enforced here even though the schema
-- (unique(branch_id, user_id, role_id)) would technically allow more: any
-- existing role row for this user at this branch is replaced, not added
-- to, matching the single-select UI. p_new_role_id = null removes the
-- person's access at that branch entirely.
create or replace function update_staff_role(
  p_user_id uuid,
  p_branch_id uuid,
  p_new_role_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_business_id uuid;
  v_target_business_id uuid;
  v_role_name text;
  v_role_is_system boolean;
begin
  if p_user_id = v_caller then
    raise exception 'Cannot change your own role — ask another admin' using errcode = '42501';
  end if;

  select business_id into v_business_id from profiles where id = v_caller;
  if v_business_id is null then
    raise exception 'Caller is not linked to a business' using errcode = '42501';
  end if;

  if not app_has_permission(v_business_id, 'users.manage') and not app_is_super_admin() then
    raise exception 'Not authorized to change staff roles' using errcode = '42501';
  end if;

  select business_id into v_target_business_id from profiles where id = p_user_id;
  if v_target_business_id is distinct from v_business_id then
    raise exception 'Staff member not found' using errcode = 'P0002';
  end if;

  if not exists (select 1 from branches where id = p_branch_id and business_id = v_business_id) then
    raise exception 'Branch does not belong to this business' using errcode = '22023';
  end if;

  if p_new_role_id is not null then
    select name, is_system_role into v_role_name, v_role_is_system
    from roles where id = p_new_role_id and business_id = v_business_id;

    if v_role_name is null then
      raise exception 'Role does not belong to this business' using errcode = '22023';
    end if;

    if v_role_name = 'Owner' and v_role_is_system
       and not app_has_permission(v_business_id, 'business.manage')
       and not app_is_super_admin()
    then
      raise exception 'Only an Owner can grant the Owner role' using errcode = '42501';
    end if;
  end if;

  -- Guard against a change that would leave the business with no Owner —
  -- only relevant if the target currently holds Owner and the new role
  -- (if any) is not also Owner.
  if (v_role_name is distinct from 'Owner')
     and exists (
       select 1 from user_branch_roles ubr
       join roles r on r.id = ubr.role_id
       where ubr.user_id = p_user_id and r.business_id = v_business_id
         and r.name = 'Owner' and r.is_system_role
     )
  then
    perform assert_owner_remains_after(v_business_id, p_user_id);
  end if;

  delete from user_branch_roles
    where business_id = v_business_id and branch_id = p_branch_id and user_id = p_user_id;

  if p_new_role_id is not null then
    insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
      values (v_business_id, p_branch_id, p_user_id, p_new_role_id, v_caller);
  end if;

  perform log_audit_event(
    v_business_id, p_branch_id, 'user.role_changed', 'profile', p_user_id,
    jsonb_build_object('new_role_name', v_role_name)
  );
end;
$$;

comment on function update_staff_role is
  'Replaces (or removes, if p_new_role_id is null) a colleague''s role at one branch. Caller cannot act on their own row. Granting Owner additionally requires business.manage. Refuses to leave the business with zero active Owner-role holders.';

revoke all on function update_staff_role(uuid, uuid, uuid) from public;
grant execute on function update_staff_role(uuid, uuid, uuid) to authenticated;

-- ── set_staff_status ─────────────────────────────────────────────────────
create or replace function set_staff_status(
  p_user_id uuid,
  p_new_status text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_business_id uuid;
  v_target_business_id uuid;
begin
  if p_new_status not in ('active', 'inactive') then
    raise exception 'Status must be active or inactive' using errcode = '22023';
  end if;

  if p_user_id = v_caller then
    raise exception 'Cannot change your own status — ask another admin' using errcode = '42501';
  end if;

  select business_id into v_business_id from profiles where id = v_caller;
  if v_business_id is null then
    raise exception 'Caller is not linked to a business' using errcode = '42501';
  end if;

  if not app_has_permission(v_business_id, 'users.manage') and not app_is_super_admin() then
    raise exception 'Not authorized to change staff status' using errcode = '42501';
  end if;

  select business_id into v_target_business_id from profiles where id = p_user_id;
  if v_target_business_id is distinct from v_business_id then
    raise exception 'Staff member not found' using errcode = 'P0002';
  end if;

  if p_new_status = 'inactive' then
    perform assert_owner_remains_after(v_business_id, p_user_id);
  end if;

  update profiles set status = p_new_status::profile_status where id = p_user_id;

  perform log_audit_event(
    v_business_id, null, case when p_new_status = 'active' then 'user.reactivated' else 'user.deactivated' end,
    'profile', p_user_id, '{}'::jsonb
  );
end;
$$;

comment on function set_staff_status is
  'Activates or deactivates a colleague''s account (blocks sign-in — see app/(app)/layout.tsx). Caller cannot act on their own row, and cannot deactivate the business''s last remaining active Owner.';

revoke all on function set_staff_status(uuid, text) from public;
grant execute on function set_staff_status(uuid, text) to authenticated;