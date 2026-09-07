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

-- Supabase's Storage schema: just enough of `storage.buckets` /
-- `storage.objects` / `storage.foldername()` for a migration that creates
-- a bucket and RLS-scopes it to work here, the same way `auth` above is
-- stubbed rather than real. Migration 0045 (service provider photos) is
-- the first migration in the project's history to touch storage.* at
-- all, so this harness never needed it before now.
--
-- On a real Supabase project this schema and both tables already exist
-- from provisioning, and storage.objects already has row level security
-- enabled — which is exactly why 0045 does NOT run `alter table
-- storage.objects enable row level security` itself (that statement is
-- rejected there with "must be owner of table objects"). Here, this
-- harness creates the tables fresh as their owner, so enabling RLS is
-- both necessary and allowed — it belongs in the stub, not the
-- migration, precisely because the two environments differ on who owns
-- the table.
create schema storage;

create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb
);

alter table storage.objects enable row level security;

-- Real signature: storage.foldername(name text) returns text[], the
-- path's segments minus the trailing filename — e.g. 'a/b/c.jpg' -> {a,b}.
-- 0045's policies read segment [1] off this as the leading business_id.
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1 : greatest(array_length(parts, 1) - 1, 0)];
end;
$$;

-- Matches Supabase's own default grants on these tables: both anon and
-- authenticated can read buckets and read/write objects, gated by RLS;
-- service_role bypasses RLS entirely (bypassrls, set above) but still
-- needs the underlying table grants.
grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;