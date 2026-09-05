-- Busihub — 0035: Super Admin bootstrap
--
-- Every RLS policy in this database already carves out `app_is_super_admin()`
-- (0008) as an escape hatch, and profiles.is_super_admin (0004) already has
-- a trigger (prevent_protected_profile_changes, 0009) that refuses to change
-- it except through a "privileged server-side function". That machinery has
-- existed since the earliest phases. What has never existed is the function
-- itself — nothing has ever actually been able to grant is_super_admin to
-- anyone. This migration adds exactly that, and nothing else: no new
-- tables, no new columns. The application-layer /admin console that uses
-- this (business list, suspend/reactivate) ships alongside this migration
-- but needs no schema of its own — it reads businesses/profiles/sales
-- through the RLS policies that already allow a super admin through, and
-- writes through log_audit_event(), which has also existed since 0007/0008
-- but has never actually been called until now.

create or replace function bootstrap_super_admin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from profiles where id = p_user_id) then
    raise exception 'No profile with id %', p_user_id;
  end if;

  perform set_config('busihub.privileged_write', 'on', true);
  update profiles set is_super_admin = true where id = p_user_id;
  perform set_config('busihub.privileged_write', 'off', true);

  -- actor_user_id inside log_audit_event() is auth.uid() — null here,
  -- since this runs from the SQL editor as the postgres/service role, not
  -- through a user's authenticated session. That is expected and fine:
  -- the point of this row is "who was granted", not "who granted it" (the
  -- answer to the latter is always "whoever has direct database access",
  -- which is exactly why this function is not reachable any other way).
  perform log_audit_event(null, null, 'platform.super_admin_granted', 'profile', p_user_id, '{}'::jsonb);
end;
$$;

comment on function bootstrap_super_admin is
  'The only sanctioned way to set profiles.is_super_admin = true. Deliberately not usable by the application: run it by hand in the Supabase SQL editor (as the postgres/service role) — select bootstrap_super_admin(''<auth-user-id>''); — to grant Super Admin. Never call this from a Server Action, Route Handler, or any client-reachable code path.';

-- Belt-and-braces: Postgres grants EXECUTE on a new function to PUBLIC by
-- default, and both `anon` and `authenticated` (the roles PostgREST/Supabase
-- Auth actually connect as) inherit PUBLIC grants. Without this revoke, the
-- function would work correctly today but would be one accidental
-- `supabase.rpc('bootstrap_super_admin', ...)` call away from being
-- reachable from application code — the same "never trust client-supplied
-- permission values" principle as everywhere else in this schema, applied
-- to the one function where getting it wrong would be worst.
revoke all on function bootstrap_super_admin(uuid) from public, anon, authenticated;