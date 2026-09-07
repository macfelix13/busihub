-- Busihub — 0044: "No sale" (open the cash drawer without a sale)
--
-- Part of "some products and services should be available in the till,
-- then we do scanning, printing part" — the scanning/printing follow-up.
-- Printing itself needed no new backend work: app/(app)/sales/[id]/receipt
-- already builds a formatted receipt and prints it via the browser's own
-- print dialog (lib/receipts/format.ts), and the chosen architecture for
-- the cash drawer (asked directly before writing any code) is to rely on
-- the receipt printer's OWN driver setting that pulses the drawer on any
-- print job — not direct in-app hardware control (WebUSB), which would
-- only work in Chrome/Edge on a desktop and would leave a till running on
-- a phone or Safari with no printing at all.
--
-- What that architecture does NOT cover is opening the drawer without
-- printing a real sale — a cashier giving change or fixing a mistake.
-- Asked directly whether that should exist at all: yes, but permission-
-- gated and logged, since an always-available drawer-open button is a
-- known till-fraud vector. This migration adds exactly that permission.
--
-- This is also the first time this project has added a brand-new
-- permission to the catalog since the initial seed (0010/0011) — a case
-- docs/RBAC.md's "Adding a new permission-gated action" section and the
-- 0040 services header both already anticipated and explicitly flagged
-- as needing "a separate backfill migration [to touch] every tenant's
-- role_permissions rows... a kind of migration this codebase has no
-- precedent for". This migration is that precedent: it backfills every
-- already-registered business's Owner and Manager roles, not only new
-- ones going forward.

insert into permissions (key, category, description) values
  ('sales.no_sale', 'sales', 'Open the cash drawer without a sale (e.g. giving change, correcting a mistake)');

-- Manager gains it going forward; Owner already gets every permission in
-- the catalog via the unfiltered `select ... from permissions` below, so
-- there is nothing to add for Owner specifically. Cashier is deliberately
-- left without it by default — the same "not every plausible action goes
-- to every role automatically" call already made for
-- discounts.apply.unlimited — an Owner can grant it to a trusted cashier
-- explicitly via Settings → Staff → Roles, which already lists every
-- permission in the catalog without needing any change for this one.
create or replace function seed_default_roles_for_business(p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role_id uuid;
begin
  -- Owner: every permission in the catalog.
  insert into roles (business_id, name, description, is_system_role)
    values (p_business_id, 'Owner', 'Full access to everything in the business.', true)
    returning id into v_role_id;
  insert into role_permissions (role_id, permission_id)
    select v_role_id, id from permissions;

  -- Manager
  insert into roles (business_id, name, description, is_system_role)
    values (p_business_id, 'Manager', 'Day-to-day operational management.', true)
    returning id into v_role_id;
  insert into role_permissions (role_id, permission_id)
    select v_role_id, id from permissions
    where key in (
      'products.view','products.create','products.edit','products.archive','products.change_price',
      'inventory.view','inventory.adjust','inventory.receive','inventory.transfer',
      'suppliers.view','suppliers.manage','purchase_orders.create','purchase_orders.approve',
      'customers.view','customers.edit',
      'sales.process','sales.void','discounts.apply','sales.refund','sales.hold','sales.no_sale',
      'reports.view','reports.export','financial.view',
      'expenses.view','expenses.create','expenses.approve',
      'users.manage','audit.view','approvals.decide'
    );

  -- Cashier
  insert into roles (business_id, name, description, is_system_role)
    values (p_business_id, 'Cashier', 'Front-of-house sales.', true)
    returning id into v_role_id;
  insert into role_permissions (role_id, permission_id)
    select v_role_id, id from permissions
    where key in (
      'products.view','customers.view','customers.edit',
      'sales.process','sales.hold','discounts.apply','inventory.view'
    );

  -- Inventory Manager
  insert into roles (business_id, name, description, is_system_role)
    values (p_business_id, 'Inventory Manager', 'Stock, receiving, and purchasing.', true)
    returning id into v_role_id;
  insert into role_permissions (role_id, permission_id)
    select v_role_id, id from permissions
    where key in (
      'products.view','products.create','products.edit',
      'inventory.view','inventory.adjust','inventory.receive','inventory.transfer',
      'suppliers.view','suppliers.manage','purchase_orders.create','purchase_orders.approve',
      'reports.view'
    );

  -- Accountant
  insert into roles (business_id, name, description, is_system_role)
    values (p_business_id, 'Accountant', 'Financial records and reporting.', true)
    returning id into v_role_id;
  insert into role_permissions (role_id, permission_id)
    select v_role_id, id from permissions
    where key in (
      'financial.view','reports.view','reports.export',
      'expenses.view','expenses.create','expenses.approve',
      'customers.view','suppliers.view','audit.view'
    );

  -- Auditor: read-only oversight.
  insert into roles (business_id, name, description, is_system_role)
    values (p_business_id, 'Auditor', 'Read-only oversight.', true)
    returning id into v_role_id;
  insert into role_permissions (role_id, permission_id)
    select v_role_id, id from permissions
    where key in (
      'audit.view','reports.view','financial.view',
      'products.view','inventory.view','customers.view','suppliers.view'
    );
end;
$$;

revoke execute on function seed_default_roles_for_business(uuid) from public;

comment on function seed_default_roles_for_business is
  'Seeds the six built-in system roles and their permission grants for a brand-new business. Updated in 0044 to add sales.no_sale to Manager (Owner already gets every permission via the unfiltered catalog select above) — this only takes effect for a business registered from 0044 onward, so 0044 also runs a one-off backfill against every already-registered business''s Owner/Manager roles. See that migration''s own header.';

-- Backfill: every EXISTING business's Owner and Manager system roles get
-- the new permission too — seed_default_roles_for_business() above only
-- ever runs once, at registration, so without this only a business
-- created after this migration would ever see it. (role_id, permission_id)
-- is role_permissions' own primary key, so this is safe to re-run.
insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
cross join permissions p
where r.is_system_role and r.name in ('Owner', 'Manager') and p.key = 'sales.no_sale'
on conflict (role_id, permission_id) do nothing;