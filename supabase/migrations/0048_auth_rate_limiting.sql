-- Busihub — 0048: rate limiting / lockout on password-based sign-in and
-- password-reset requests (security-audit Gap #1, 2026-09 review, ranked
-- High and treated as the one launch-blocking item).
--
-- Before this migration, three code paths called Supabase Auth directly
-- with no attempt counter, delay, or lockout at all:
--   - app/(auth)/login/actions.ts            (login())
--   - app/(app)/till/actions.ts               (switchTillUser())
--   - app/(auth)/reset-password/actions.ts    (requestPasswordReset())
-- Unlimited password-guessing against a known email was possible from the
-- app's own code, with no backstop configured anywhere in this repo. The
-- cashier PIN (the till's own second factor, migration 0039) already had
-- a real DB-enforced 5-attempts/15-minute lockout via
-- verify_profile_pin()/profiles.pin_failed_attempts/pin_locked_until —
-- but that only ever matters after a real Supabase Auth login has already
-- succeeded.
--
-- This migration gives login and till "switch user" the same shape of
-- protection PINs already have, and gives password-reset requests a
-- request-count limiter — but keyed by an arbitrary string rather than a
-- profile id, because there is no profile row to attach a counter to
-- before a login has even succeeded (indeed the whole point is this must
-- work for an email that may not exist, without revealing which).
--
-- Both login and password-reset run BEFORE a session exists, so the
-- calling Postgres role is `anon`, not `authenticated` — these functions
-- are granted to both.

create table auth_rate_limits (
  rate_key      text primary key,
  attempt_count int not null default 0,
  locked_until  timestamptz,
  updated_at    timestamptz not null default now()
);

comment on table auth_rate_limits is
  'Generic failed-attempt / request counters for pre-session or unauthenticated auth flows (password login, till switch-user sign-in, password-reset requests) — the same DB-enforced lockout shape as profiles.pin_failed_attempts/pin_locked_until (0039), but keyed by an arbitrary caller-chosen string (e.g. "login:<email>") rather than a profile id. All reads/writes go through auth_rate_limit_check()/auth_rate_limit_record() below, both SECURITY DEFINER; RLS is enabled here with no policies at all, as a deliberate closed door — nothing should ever select or update this table directly.';

alter table auth_rate_limits enable row level security;

-- ── auth_rate_limit_check(): is this key currently locked? ───────────────
--
-- Returns the lockout's expiry if locked, or null if the key is free to
-- try (including a key never seen before). Read-only — callers check
-- this BEFORE attempting the real operation, so a locked-out caller never
-- even reaches Supabase Auth / triggers a password-reset email.

create or replace function auth_rate_limit_check(p_key text)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select locked_until from auth_rate_limits
  where rate_key = p_key and locked_until is not null and locked_until > now();
$$;

comment on function auth_rate_limit_check(text) is
  'Returns the lockout expiry for p_key if it is currently locked, otherwise null. Read-only — pair with auth_rate_limit_record() after the real attempt. p_key is an arbitrary caller-chosen string (e.g. "login:someone@example.com") — this function does not interpret it or check it against auth.uid(), since it must also work before a session exists.';

grant execute on function auth_rate_limit_check(text) to anon, authenticated;

-- ── auth_rate_limit_record(): record what just happened ───────────────────
--
-- p_success = true resets the counter and clears any lockout (a genuine
-- login succeeded — the same "wrong attempts forgotten on success" shape
-- verify_profile_pin() already uses). p_success = false increments the
-- counter and, once it reaches p_max_attempts, locks the key for
-- p_lockout_minutes and resets the counter to 0 so the next window starts
-- fresh once the lockout expires.
--
-- Password-reset requests are not a "succeed/fail" operation from the
-- caller's point of view (Supabase's resetPasswordForEmail() always
-- "succeeds" whether or not the email exists, by design — Section 6/29,
-- account-enumeration resistance). For that flow, callers always pass
-- p_success = false on every request, which turns this into a plain
-- request-count limiter: after p_max_attempts requests it locks for
-- p_lockout_minutes, then allows another batch. That is enough to stop
-- an email-bombing / enumeration-timing abuse pattern without needing a
-- true sliding window.

create or replace function auth_rate_limit_record(
  p_key text,
  p_success boolean,
  p_max_attempts int default 8,
  p_lockout_minutes int default 15
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_key is null or trim(p_key) = '' then
    return;
  end if;

  insert into auth_rate_limits (rate_key, attempt_count, locked_until, updated_at)
  values (p_key, case when p_success then 0 else 1 end, null, now())
  on conflict (rate_key) do update
  set attempt_count = case when p_success then 0 else auth_rate_limits.attempt_count + 1 end,
      locked_until = case
        when p_success then null
        when auth_rate_limits.attempt_count + 1 >= p_max_attempts
          then now() + (greatest(p_lockout_minutes, 1) || ' minutes')::interval
        else auth_rate_limits.locked_until
      end,
      updated_at = now();
end;
$$;

comment on function auth_rate_limit_record(text, boolean, int, int) is
  'Records one attempt against p_key and applies/clears a lockout accordingly. p_success = true resets the counter (mirrors verify_profile_pin()''s own-attempt reset, 0039). p_success = false always passed for password-reset requests, turning this into a plain request-count limiter rather than a failure counter, since that flow must not reveal whether the email exists via success/failure at all.';

grant execute on function auth_rate_limit_record(text, boolean, int, int) to anon, authenticated;