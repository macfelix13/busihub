-- Busihub — 0018: PIN security hardening + till login (Phase 9, part 1)
--
-- Phase 2 built the PIN columns and deferred the entry screen to the POS
-- phase. Building that screen meant looking properly at how the columns
-- are protected, and two real holes turned up — both found by querying a
-- live database as a Cashier, not by reading the schema:
--
--   1. ANY colleague could read ANY other profile's pin_hash. profiles'
--      RLS scopes rows to the business, but column privileges are a
--      separate mechanism, and 0009 granted SELECT on every column to
--      `authenticated`. So a cashier could fetch the owner's bcrypt hash
--      straight from PostgREST in the browser. A PIN is 4–6 digits by
--      design; bcrypt at cost 10 does not save a 10^4 keyspace from an
--      offline attack. That is a direct escalation path to whoever
--      authorises discounts, voids and refunds at the till.
--
--   2. A user could reset their OWN pin_failed_attempts and
--      pin_locked_until. The self-update policy on profiles is
--      necessarily permissive, and 0009's escalation guard covered
--      is_super_admin, business_id and pin_hash — but not the lockout
--      counters. The lockout was therefore bypassable by precisely the
--      person being locked out, which is the only person it exists to
--      stop. Verified with a real UPDATE: it reported "UPDATE 1".
--
-- Both are closed below. The design consequence is that the hash never
-- leaves the database at all: hashing AND verification happen here, in
-- SECURITY DEFINER functions, using pgcrypto's crypt() — the same
-- approach Supabase's own auth takes for passwords. Doing the comparison
-- in the database is also what lets a failed attempt increment the
-- counter atomically with the check, rather than in a separate round trip
-- a caller could simply skip.
--
-- Note on the plaintext PIN crossing the wire: it travels inside a TLS
-- request to a parameterised RPC, exactly as a password does to any login
-- endpoint. Do not enable Postgres statement logging with parameter
-- values in production — see docs/SECURITY.md.

-- ── 1. The hash stops being readable by clients ──────────────────────────
--
-- Column-level, because the row is legitimately readable: a cashier needs
-- to see their colleagues' names to pick one at the till. It is only this
-- column they must never see.
--
-- A bare `revoke select (pin_hash)` does NOT work here, and quietly does
-- nothing: 0009 granted table-level SELECT on every table, and in
-- Postgres a table-level privilege authorises every column regardless of
-- any column-level revoke. (Confirmed by trying it — the hash still came
-- back.) The table grant has to go first, then every column EXCEPT the
-- hash is granted back explicitly.
--
-- MAINTENANCE: a future migration that adds a column to profiles must add
-- it to this grant too, or it will be unreadable. That cost is accepted
-- deliberately — the alternative is a readable password-equivalent.
revoke select on profiles from authenticated, anon;

grant select (
  id, business_id, first_name, last_name, display_name, email, phone,
  avatar_url, status, is_super_admin,
  -- pin_hash deliberately absent.
  pin_set_at, pin_failed_attempts, pin_locked_until,
  last_login_at, created_at, updated_at
) on profiles to authenticated;

-- anon reaches no profile row anyway (RLS needs an auth.uid()), but the
-- grant is narrowed to match rather than relying on that alone.
grant select (id, business_id, first_name, last_name, display_name, status) on profiles to anon;

-- The lockout counters stay readable — "is this person locked out?" is
-- not a secret, and the till needs to say so. What matters is that they
-- cannot be WRITTEN by the user they lock out; that is the trigger below,
-- not a grant, because the same table-level-grant rule would defeat a
-- column-level revoke on UPDATE in exactly the same way.

-- ── 2. The lockout counters become tamper-proof ──────────────────────────
--
-- Replaces 0009's version, adding the three PIN columns it did not cover.
-- Same mechanism: these may only change inside a server-side function
-- that explicitly opts in with the busihub.privileged_write flag.
create or replace function prevent_protected_profile_changes()
returns trigger
language plpgsql
as $$
begin
  if (new.is_super_admin is distinct from old.is_super_admin)
     or (new.business_id is distinct from old.business_id)
     or (new.pin_hash is distinct from old.pin_hash)
     or (new.pin_set_at is distinct from old.pin_set_at)
     or (new.pin_failed_attempts is distinct from old.pin_failed_attempts)
     or (new.pin_locked_until is distinct from old.pin_locked_until)
  then
    if coalesce(current_setting('busihub.privileged_write', true), 'off') <> 'on' then
      raise exception 'is_super_admin, business_id and the PIN fields can only be changed by a privileged server-side function'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

comment on function prevent_protected_profile_changes() is
  'Blocks self-service changes to the fields that would let a user escalate: tenancy, super-admin status, the PIN hash, and the PIN lockout counters. The counters were added in 0018 after confirming a user could clear their own lockout.';

-- ── 3. Setting a PIN ─────────────────────────────────────────────────────

create or replace function set_profile_pin(p_profile_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller     uuid := auth.uid();
  v_business   uuid;
  v_target_biz uuid;
begin
  if v_caller is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  -- 4–6 digits. Checked here as well as in the app, because this function
  -- is reachable directly and a 2-digit PIN would be a real weakening.
  if p_pin !~ '^\d{4,6}$' then
    raise exception 'A PIN must be 4 to 6 digits' using errcode = '22023';
  end if;

  select business_id into v_business from profiles where id = v_caller;
  select business_id into v_target_biz from profiles where id = p_profile_id;

  if v_target_biz is null or v_business is null or v_target_biz <> v_business then
    raise exception 'That user could not be found' using errcode = 'P0002';
  end if;

  -- Your own PIN is yours to set. Setting somebody else's is staff
  -- administration and needs users.manage.
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

grant execute on function set_profile_pin(uuid, text) to authenticated;

comment on function set_profile_pin(uuid, text) is
  'Sets a cashier PIN. Hashes with pgcrypto inside the database so the plaintext is never stored and the hash never has to be read back out. Own PIN always allowed; another user''s requires users.manage.';

-- ── 4. Verifying a PIN ───────────────────────────────────────────────────
--
-- Returns a plain boolean. The hash is compared in here, so no caller
-- ever holds it; and because the failure counter is incremented in the
-- same call, an attacker cannot simply decline to report their failures.
create or replace function verify_profile_pin(p_profile_id uuid, p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
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

  -- Same business, or nothing. Deliberately the same error for "no such
  -- user" and "another tenant's user", so this cannot be used to probe
  -- which profile ids exist elsewhere.
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
        -- Threshold and duration mirror lib/auth/pin.ts's constants.
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

grant execute on function verify_profile_pin(uuid, text) to authenticated;

comment on function verify_profile_pin(uuid, text) is
  'Verifies a cashier PIN entirely inside the database and maintains the lockout counters in the same call. Returns true/false; raises only for conditions the user needs told about (locked out, no PIN set, inactive).';

-- ── 5. Who can be picked at the till ─────────────────────────────────────
--
-- pin_set_at is deliberately NOT revoked above: "does this colleague have
-- a PIN?" is not a secret, and exposing it means the till picker is an
-- ordinary RLS-scoped select rather than another privileged function.
comment on column profiles.pin_set_at is
  'When the PIN was last set. Readable by colleagues (unlike pin_hash) so the till can list who is able to sign in.';
