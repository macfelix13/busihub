import {
  LayoutDashboard,
  ShoppingCart,
  History,
  Package,
  PackagePlus,
  Scissors,
  Boxes,
  PackageCheck,
  SlidersHorizontal,
  ClipboardList,
  Truck,
  Users,
  Receipt,
  Building2,
  Building,
  BarChart3,
  TrendingUp,
  Wallet,
  Archive,
  ReceiptText,
  Settings as SettingsIcon,
  CreditCard,
  KeyRound,
  UserCog,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

/**
 * Every permission the sidebar needs to know about, computed once
 * server-side in app/(app)/layout.tsx exactly as before (Section 49 — the
 * server-computed boolean is a UX convenience, RLS/requirePermission is
 * still the real gate on every page underneath). Three more than the old
 * flat nav needed (canCreateProducts, canReceiveInventory,
 * canAdjustInventory) because Products/Inventory becoming dropdowns gave
 * their existing action pages somewhere to live in the nav for the first
 * time — each mirrors the exact permission the target page itself already
 * enforces, not a new rule invented for the sidebar.
 */
export interface NavPermissions {
  canSell: boolean;
  /** canSell || canViewReports — the same rule app/(app)/sales/page.tsx's
   *  own access check uses, mirrored here rather than invented fresh. */
  canViewSalesHistory: boolean;
  canViewProducts: boolean;
  canCreateProducts: boolean;
  canViewInventory: boolean;
  canReceiveInventory: boolean;
  canAdjustInventory: boolean;
  canViewSuppliers: boolean;
  canViewCustomers: boolean;
  canViewExpenses: boolean;
  canManageBranches: boolean;
  canViewReports: boolean;
  canManageBusiness: boolean;
  canManageUsers: boolean;
  canViewAudit: boolean;
}

export interface NavLeaf {
  kind: "leaf";
  label: string;
  href: string;
  icon: LucideIcon;
  /** undefined = always visible (Dashboard, My PIN). */
  permission?: keyof NavPermissions;
}

export interface NavGroup {
  kind: "group";
  label: string;
  icon: LucideIcon;
  children: NavLeaf[];
}

export type NavEntry = NavLeaf | NavGroup;

function leaf(label: string, href: string, icon: LucideIcon, permission?: keyof NavPermissions): NavLeaf {
  return { kind: "leaf", label, href, icon, permission };
}

function group(label: string, icon: LucideIcon, children: NavLeaf[]): NavGroup {
  return { kind: "group", label, icon, children };
}

/**
 * The full nav tree, unfiltered. isLeafVisible()/isGroupVisible() below
 * decide what a given user actually sees — a group with zero visible
 * children simply doesn't render, rather than every group needing its own
 * hand-picked "does this person have SOME reason to see this" permission.
 */
export const NAV_TREE: NavEntry[] = [
  leaf("Till", "/till", ShoppingCart, "canSell"),
  leaf("Sales", "/sales", History, "canViewSalesHistory"),
  leaf("Dashboard", "/dashboard", LayoutDashboard),
  group("Products", Package, [
    leaf("All Products", "/products", Package, "canViewProducts"),
    leaf("Add Product", "/products/new", PackagePlus, "canCreateProducts"),
    // Services (braiding, sewing, barbering...) are products with
    // type='service' under the hood (migration 0040) — reusing the exact
    // same products.view/products.create permissions rather than a
    // separate services.* set, per that migration's header.
    leaf("Services", "/products?type=service", Scissors, "canViewProducts"),
    leaf("Add Service", "/products/new?type=service", Scissors, "canCreateProducts"),
  ]),
  group("Inventory", Boxes, [
    leaf("Stock Levels", "/inventory", Boxes, "canViewInventory"),
    leaf("Receive Stock", "/inventory/receive", PackageCheck, "canReceiveInventory"),
    leaf("Adjust Stock", "/inventory/adjust", SlidersHorizontal, "canAdjustInventory"),
    leaf("Stock Count", "/inventory/count", ClipboardList, "canAdjustInventory"),
  ]),
  group("Operations", Truck, [
    leaf("Orders", "/purchase-orders", ClipboardList, "canViewSuppliers"),
    leaf("Suppliers", "/suppliers", Truck, "canViewSuppliers"),
    leaf("Customers", "/customers", Users, "canViewCustomers"),
    leaf("Expenses", "/expenses", Receipt, "canViewExpenses"),
    leaf("Branches", "/branches", Building2, "canManageBranches"),
  ]),
  group("Reports", BarChart3, [
    leaf("Overview", "/reports", BarChart3, "canViewReports"),
    leaf("Profit & Loss", "/reports/profit-loss", TrendingUp, "canViewReports"),
    leaf("Receivables", "/reports/receivables", Wallet, "canViewReports"),
    leaf("Stock Valuation", "/reports/stock", Archive, "canViewReports"),
    leaf("Sales", "/reports/sales", ReceiptText, "canViewReports"),
  ]),
  group("Settings", SettingsIcon, [
    leaf("Business", "/settings/business", Building, "canManageBusiness"),
    leaf("Payments", "/settings/payments", CreditCard, "canManageBusiness"),
    leaf("Staff", "/settings/staff", UserCog, "canManageUsers"),
    leaf("Audit Log", "/settings/audit-log", ShieldCheck, "canViewAudit"),
  ]),
  leaf("My PIN", "/settings/pin", KeyRound),
];

export function isLeafVisible(item: NavLeaf, perms: NavPermissions): boolean {
  return item.permission === undefined || perms[item.permission];
}

export function isGroupVisible(item: NavGroup, perms: NavPermissions): boolean {
  return item.children.some((child) => isLeafVisible(child, perms));
}