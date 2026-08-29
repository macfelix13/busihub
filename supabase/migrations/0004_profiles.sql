-- Busihub — 0004: profiles
-- 1:1 with auth.users. Supabase Auth owns credentials; this table owns the
-- business-domain identity (who this person is, which business/branch they
-- belong to, their cashier PIN hash, their status).

create type profile_status as enum ('active', 'inactive', 'suspended');

create table profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  -- Null only for Super Admin platform staff, who are not tenants of any
  -- business. Every ordinary user must belong to exactly one business.
  business_id     uuid references businesses(id) on delete cascade,
  first_name      text not null check (char_length(trim(first_name)) > 0),
  last_name       text not null default '',
  display_name    text generated always as (trim(first_name || ' ' || last_name)) stored,
  email           citext,
  phone           text,
  avatar_url      text,
  status          profile_status not null default 'active',
  is_super_admin  boolean not null default false,
  -- Cashier PIN: bcrypt/argon2 hash only, never plaintext, never compared
  -- client-side (see lib/auth/pin.ts + docs/AUTH.md). Null until the user
  -- (or an admin on their behalf) sets one.
  pin_hash        text,
  pin_set_at      timestamptz,
  pin_failed_attempts integer not null default 0,
  pin_locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint profiles_business_required_unless_super_admin
    check (is_super_admin or business_id is not null)
);

create index profiles_business_id_idx on profiles (business_id);

create trigger set_updated_at
  before update on profiles
  for each row execute function set_updated_at();

comment on table profiles is 'Business-domain identity for an auth.users row. Never store password or PIN in plaintext here — pin_hash is a bcrypt/argon2 hash produced server-side.';
comment on column profiles.is_super_admin is 'Platform-level privilege, unrelated to any business. Never settable through a client-exposed API — only via direct database access or a dedicated, audited Super Admin bootstrap procedure.';

-- Now that profiles exists, wire up businesses.created_by.
alter table businesses
  add constraint businesses_created_by_fkey
  foreign key (created_by) references profiles(id);
