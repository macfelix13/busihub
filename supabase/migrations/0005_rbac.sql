-- Busihub — 0005: roles, permissions, role_permissions, user_branch_roles
--
-- Model: `permissions` is a fixed, platform-wide catalog of granular
-- action strings (seeded in 0010). `roles` are business-scoped rows —
-- built-in roles (Owner, Manager, Cashier, ...) are seeded per business at
-- registration as real rows (is_system_role = true), not hardcoded
-- strings, so an Owner can view/adjust their permission grants like any
-- custom role. A user holds a role per branch via user_branch_roles, so
-- the same person can be a Manager at one branch and a Cashier at another.

create table permissions (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,              -- e.g. 'products.create'
  category    text not null,                      -- e.g. 'products', 'sales', 'inventory'
  description text not null,
  created_at  timestamptz not null default now()
);

comment on table permissions is 'Fixed platform-wide catalog of granular permission strings. Not tenant-scoped. Modified only via migration, never by tenant admins.';

create table roles (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id) on delete cascade,
  name           text not null check (char_length(trim(name)) > 0),
  description    text,
  is_system_role boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (business_id, name)
);

create index roles_business_id_idx on roles (business_id);

create trigger set_updated_at
  before update on roles
  for each row execute function set_updated_at();

comment on table roles is 'Business-scoped roles. Built-in roles are real rows (is_system_role = true) seeded per business at registration; custom roles are ordinary rows created by anyone holding roles.manage.';

create table role_permissions (
  role_id       uuid not null references roles(id) on delete cascade,
  permission_id uuid not null references permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table user_branch_roles (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  branch_id    uuid not null references branches(id) on delete cascade,
  user_id      uuid not null references profiles(id) on delete cascade,
  role_id      uuid not null references roles(id) on delete cascade,
  granted_by   uuid references profiles(id),
  granted_at   timestamptz not null default now(),
  unique (branch_id, user_id, role_id)
);

create index user_branch_roles_business_id_idx on user_branch_roles (business_id);
create index user_branch_roles_user_id_idx on user_branch_roles (user_id);
create index user_branch_roles_branch_id_idx on user_branch_roles (branch_id);

comment on table user_branch_roles is 'A user''s role assignment at a specific branch. A business-wide role (e.g. Owner) is granted at every branch of the business at assignment time — see lib/rbac/assign-role.ts.';

-- role_permissions rows only make sense for a role and permission that
-- exist; also guard against assigning a role from a different business
-- to a branch that does not belong to that business.
alter table user_branch_roles
  add constraint user_branch_roles_branch_matches_business
  check (true); -- enforced via trigger below (cross-table checks need a trigger, not a CHECK)

create or replace function enforce_branch_role_business_match()
returns trigger
language plpgsql
as $$
declare
  v_branch_business_id uuid;
  v_role_business_id uuid;
begin
  select business_id into v_branch_business_id from branches where id = new.branch_id;
  select business_id into v_role_business_id from roles where id = new.role_id;

  if v_branch_business_id is distinct from new.business_id
     or v_role_business_id is distinct from new.business_id then
    raise exception 'user_branch_roles: branch_id and role_id must belong to the same business_id'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger enforce_branch_role_business_match
  before insert or update on user_branch_roles
  for each row execute function enforce_branch_role_business_match();
