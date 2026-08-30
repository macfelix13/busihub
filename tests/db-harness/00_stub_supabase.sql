-- NOT part of the real schema. Local-only stub that approximates just
-- enough of Supabase's auth schema/roles to let us apply the real
-- migrations against a plain local Postgres and exercise RLS, since this
-- sandbox has no network access to a real Supabase project.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

-- Supabase installs extensions into a dedicated `extensions` schema, not
-- into `public`, and sets the database search_path to include it. A plain
-- `create extension pgcrypto` here would land in public instead, which is
-- NOT what production looks like — and that difference hides a whole class
-- of bug: a SECURITY DEFINER function pinning `set search_path = public`
-- finds crypt()/gen_salt() locally and fails in production with
-- "function gen_salt(unknown, integer) does not exist". That exact bug
-- shipped once (fixed in 0019) precisely because this harness was more
-- forgiving than the real thing. Mirroring the layout here means it
-- cannot happen again unnoticed.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;

do $$
begin
  -- Database-level, so it applies to the separate psql connection each
  -- migration file runs in. Matches Supabase's own default.
  execute format('alter database %I set search_path = public, extensions', current_database());
end $$;

grant usage on schema extensions to anon, authenticated, service_role;

create schema auth;

create table auth.users (
  instance_id uuid,
  id uuid primary key,
  aud text,
  role text,
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase's own bootstrap gives service_role blanket table access — it is
-- the key that bypasses RLS, and it is expected to reach everything — and
-- sets default privileges so tables created by later migrations are
-- covered too. Our migrations only ever grant to `authenticated` and
-- `anon`, because on a real project service_role is already handled.
--
-- Without this the harness diverges from production in the one direction
-- that hides bugs rather than causing them: server-side code would fail
-- here and work there, or (worse) a test would "prove" service_role is
-- locked out of something it can in fact read. This is the same class of
-- gap as the pgcrypto/extensions schema above, which shipped a broken
-- PIN function past five green suites.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
