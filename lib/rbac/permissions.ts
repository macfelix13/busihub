/**
 * Mirrors the `permissions.key` catalog seeded in
 * supabase/migrations/0010_seed_platform_catalog.sql. Kept as a typed
 * constant so application code gets compile-time checking on permission
 * strings instead of typo-prone free text — but the database catalog
 * (and the RLS policies that reference it via app_has_permission) remain
 * the actual source of truth and the real enforcement boundary. If these
 * two ever drift, the database wins; update this file to match it, never
 * the other way around.
 */
export const PERMISSIONS = {
  PRODUCTS_VIEW: "products.view",
  PRODUCTS_CREATE: "products.create",
  PRODUCTS_EDIT: "products.edit",
  PRODUCTS_ARCHIVE: "products.archive",
  PRODUCTS_CHANGE_PRICE: "products.change_price",

  INVENTORY_VIEW: "inventory.view",
  INVENTORY_ADJUST: "inventory.adjust",
  INVENTORY_RECEIVE: "inventory.receive",
  INVENTORY_TRANSFER: "inventory.transfer",

  SUPPLIERS_VIEW: "suppliers.view",
  SUPPLIERS_MANAGE: "suppliers.manage",
  PURCHASE_ORDERS_CREATE: "purchase_orders.create",
  PURCHASE_ORDERS_APPROVE: "purchase_orders.approve",

  CUSTOMERS_VIEW: "customers.view",
  CUSTOMERS_EDIT: "customers.edit",

  SALES_PROCESS: "sales.process",
  SALES_VOID: "sales.void",
  DISCOUNTS_APPLY: "discounts.apply",
  DISCOUNTS_APPLY_UNLIMITED: "discounts.apply.unlimited",
  SALES_REFUND: "sales.refund",
  SALES_HOLD: "sales.hold",

  REPORTS_VIEW: "reports.view",
  REPORTS_EXPORT: "reports.export",
  FINANCIAL_VIEW: "financial.view",
  EXPENSES_VIEW: "expenses.view",
  EXPENSES_CREATE: "expenses.create",
  EXPENSES_APPROVE: "expenses.approve",

  USERS_MANAGE: "users.manage",
  ROLES_MANAGE: "roles.manage",
  BUSINESS_MANAGE: "business.manage",
  BRANCHES_MANAGE: "branches.manage",
  AUDIT_VIEW: "audit.view",
  APPROVALS_DECIDE: "approvals.decide",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const BUILT_IN_ROLE_NAMES = [
  "Owner",
  "Manager",
  "Cashier",
  "Inventory Manager",
  "Accountant",
  "Auditor",
] as const;

export type BuiltInRoleName = (typeof BUILT_IN_ROLE_NAMES)[number];
