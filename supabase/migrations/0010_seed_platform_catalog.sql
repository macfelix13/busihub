-- Busihub — 0010: platform catalog seed data
--
-- This is NOT dev/test seed data (that lives in supabase/seed.sql and is
-- never run against production — see docs/DATABASE.md). This is real
-- catalog data the application depends on to function at all: the fixed
-- permission list and the subscription plan catalog. Safe, expected, and
-- required in every environment including production.

insert into permissions (key, category, description) values
  -- products
  ('products.view',              'products',   'View products'),
  ('products.create',            'products',   'Create products'),
  ('products.edit',              'products',   'Edit products'),
  ('products.archive',           'products',   'Delete/archive products'),
  ('products.change_price',      'products',   'Change product prices'),
  -- inventory
  ('inventory.view',             'inventory',  'View inventory levels'),
  ('inventory.adjust',           'inventory',  'Adjust inventory'),
  ('inventory.receive',          'inventory',  'Receive stock'),
  ('inventory.transfer',         'inventory',  'Transfer stock between branches'),
  -- purchasing / suppliers
  ('suppliers.view',             'purchasing', 'View suppliers'),
  ('suppliers.manage',           'purchasing', 'Create/edit suppliers'),
  ('purchase_orders.create',     'purchasing', 'Create purchase orders'),
  ('purchase_orders.approve',    'purchasing', 'Approve purchase orders'),
  -- customers
  ('customers.view',             'customers',  'View customers'),
  ('customers.edit',             'customers',  'Edit customers'),
  -- sales / POS
  ('sales.process',              'sales',      'Process sales'),
  ('sales.void',                 'sales',      'Void transactions'),
  ('discounts.apply',            'sales',      'Apply discounts up to their role''s configured cap'),
  ('discounts.apply.unlimited',  'sales',      'Apply discounts without a cap'),
  ('sales.refund',               'sales',      'Refund sales'),
  ('sales.hold',                 'sales',      'Hold/resume sales'),
  -- financial / reports
  ('reports.view',               'reports',    'View reports'),
  ('reports.export',             'reports',    'Export reports'),
  ('financial.view',             'financial',  'View financial data'),
  ('expenses.view',              'expenses',   'View expenses'),
  ('expenses.create',            'expenses',   'Record expenses'),
  ('expenses.approve',           'expenses',   'Approve expenses'),
  -- administration
  ('users.manage',               'admin',      'Manage users'),
  ('roles.manage',               'admin',      'Manage roles and permission grants'),
  ('business.manage',            'admin',      'Manage business settings'),
  ('branches.manage',            'admin',      'Manage branches'),
  ('audit.view',                 'admin',      'View audit logs'),
  ('approvals.decide',           'admin',      'Approve or reject approval requests');

insert into subscription_plans (slug, name, description, price_amount, currency_code, billing_interval, limits, sort_order) values
  ('trial', 'Free Trial', '14-day trial of the Growth plan feature set.', 0, 'GHS', 'none',
    '{"max_users": 5, "max_branches": 1, "max_products": 200, "max_pos_terminals": 2, "storage_mb": 250,
      "features": {"advanced_reports": true, "api_access": false, "sms_notifications": false}}'::jsonb, 0),
  ('starter', 'Starter', 'For a single shop just getting started.', 120, 'GHS', 'month',
    '{"max_users": 3, "max_branches": 1, "max_products": 500, "max_pos_terminals": 2, "storage_mb": 500,
      "features": {"advanced_reports": false, "api_access": false, "sms_notifications": false}}'::jsonb, 1),
  ('growth', 'Growth', 'For growing businesses with more than one branch.', 350, 'GHS', 'month',
    '{"max_users": 15, "max_branches": 5, "max_products": 5000, "max_pos_terminals": 10, "storage_mb": 5000,
      "features": {"advanced_reports": true, "api_access": false, "sms_notifications": true}}'::jsonb, 2),
  ('enterprise', 'Enterprise', 'For multi-branch operations with custom needs.', 900, 'GHS', 'month',
    '{"max_users": null, "max_branches": null, "max_products": null, "max_pos_terminals": null, "storage_mb": 50000,
      "features": {"advanced_reports": true, "api_access": true, "sms_notifications": true}}'::jsonb, 3);

comment on column subscription_plans.limits is
  'null for a numeric limit means "unlimited". lib/entitlements treats a missing key the same as null (unlimited) but every plan above sets keys explicitly to avoid relying on that fallback.';
