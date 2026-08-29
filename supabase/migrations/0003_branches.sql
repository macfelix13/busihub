-- Busihub — 0003: branches

create type branch_status as enum ('active', 'inactive');

create table branches (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  name          text not null check (char_length(trim(name)) > 0),
  is_main       boolean not null default false,
  address_line1 text,
  address_line2 text,
  city          text,
  region        text,
  phone         text,
  email         citext,
  timezone      text not null default 'Africa/Accra',
  status        branch_status not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (business_id, name)
);

create index branches_business_id_idx on branches (business_id);

create trigger set_updated_at
  before update on branches
  for each row execute function set_updated_at();

-- Exactly one main branch per business (partial unique index rather than a
-- CHECK, since CHECK constraints cannot see other rows).
create unique index branches_one_main_per_business_idx
  on branches (business_id)
  where is_main;

comment on table branches is 'A physical or logical location within a business. Every business gets one branch (is_main = true) created at registration.';
