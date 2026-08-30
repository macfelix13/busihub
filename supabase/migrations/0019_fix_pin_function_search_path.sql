-- Busihub — 0019: fix the search_path on the PIN functions
--
-- 0018's set_profile_pin() and verify_profile_pin() pin
-- `set search_path = public, pg_temp`, which is the correct habit for a
-- SECURITY DEFINER function — an unpinned search_path is a classic
-- privilege-escalation vector. But it excluded the schema pgcrypto
-- actually lives in on Supabase, so both functions failed in production
-- with:
--
--     function gen_salt(unknown, integer) does not exist
--
-- Supabase installs extensions into a dedicated `extensions` schema and
-- sets the database search_path to include it; ordinary statements
-- therefore find crypt()/gen_salt() fine, and only a function that pins
-- its own search_path loses them. The local harness had been doing a
-- plain `create extension pgcrypto`, which lands in `public`, so the
-- functions resolved there and the whole suite passed against a database
-- that was more forgiving than the real one.
--
-- Fixed in two places, deliberately:
--   * here, by adding `extensions` to the pinned search_path (still
--     pinned — this is not a return to an unpinned one);
--   * in tests/db-harness/00_stub_supabase.sql, which now installs the
--     extensions into an `extensions` schema exactly as Supabase does, so
--     this class of bug fails locally instead of in production. Confirmed:
--     with the corrected harness the old function reproduces the error
--     above, and this migration makes it pass.
--
-- Naming `extensions` explicitly is safe: it is a Supabase-managed schema,
-- and listing a schema that does not exist (as on a plain Postgres) is
-- silently ignored, so this works in both environments.

create or replace function set_profile_pin(p_profile_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_caller     uuid := auth.uid();
  v_business   uuid;
  v_target_biz uuid;
begin
  if v_caller is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  if p_pin !~ '^\d{4,6}$' then
    raise exception 'A PIN must be 4 to 6 digits' using errcode = '22023';
  end if;

  select business_id into v_business from profiles where id = v_caller;
  select business_id into v_target_biz from profiles where id = p_profile_id;

  if v_target_biz is null or v_business is null or v_target_biz <> v_business then
    raise exception 'That user could not be found' using errcode = 'P0002';
  end if;

  if p_profile_id <> v_caller
     and not (app_has_permission(v_business, 'users.manage') or app_is_super_admin()) then
    raise exception 'Missing permission: users.manage' using errcode = '42501';
  end if;

  perform set_config('busihub.privileged_write', 'on', true);

  update profiles
  set pin_hash            = crypt(p_pin, gen_salt('bf', 10)),
      pin_set_at          = now(),
      pin_failed_attempts = 0,
      pin_locked_until    = null
  where id = p_profile_id;

  perform set_config('busihub.privileged_write', 'off', true);
end;
$$;

create or replace function verify_profile_pin(p_profile_id uuid, p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_caller   uuid := auth.uid();
  v_business uuid;
  v_profile  profiles%rowtype;
  v_ok       boolean;
begin
  if v_caller is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  select business_id into v_business from profiles where id = v_caller;
  select * into v_profile from profiles where id = p_profile_id;

  if v_profile.id is null or v_business is null or v_profile.business_id <> v_business then
    raise exception 'That user could not be found' using errcode = 'P0002';
  end if;

  if v_profile.status <> 'active' then
    raise exception 'That user is not active' using errcode = 'P0001';
  end if;

  if v_profile.pin_locked_until is not null and v_profile.pin_locked_until > now() then
    raise exception 'Too many wrong attempts. Try again after %',
      to_char(v_profile.pin_locked_until, 'HH24:MI')
      using errcode = 'P0001';
  end if;

  if v_profile.pin_hash is null then
    raise exception 'That user has no PIN set' using errcode = 'P0001';
  end if;

  v_ok := (crypt(p_pin, v_profile.pin_hash) = v_profile.pin_hash);

  perform set_config('busihub.privileged_write', 'on', true);

  if v_ok then
    update profiles
    set pin_failed_attempts = 0, pin_locked_until = null, last_login_at = now()
    where id = p_profile_id;
  else
    update profiles
    set pin_failed_attempts = pin_failed_attempts + 1,
        pin_locked_until = case
          when pin_failed_attempts + 1 >= 5 then now() + interval '15 minutes'
          else pin_locked_until
        end
    where id = p_profile_id;
  end if;

  perform set_config('busihub.privileged_write', 'off', true);

  return v_ok;
end;
$$;
