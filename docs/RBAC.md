# Busihub — Roles & Permissions

## Model

- `permissions` (`supabase/migrations/0005_rbac.sql`, catalog seeded in `0010_seed_platform_catalog.sql`): a fixed, platform-wide list of granular action strings, e.g. `products.create`, `sales.refund`, `discounts.apply.unlimited`. Mirrored in TypeScript as `PERMISSIONS`/`PermissionKey` (`lib/rbac/permissions.ts`) for compile-time checking — the database catalog is still the real source of truth.
- `roles`: business-scoped rows. Built-in roles (Owner, Manager, Cashier, Inventory Manager, Accountant, Auditor) are seeded per business at registration by `seed_default_roles_for_business()` (`0011_business_registration.sql`) as real rows with `is_system_role = true` — an Owner can review and adjust what each one grants; the six templates only decide the starting permission set. Custom roles are ordinary rows with `is_system_role = false`.
- `role_permissions`: many-to-many between `roles` and `permissions`.
- `user_branch_roles`: a user's role at a specific branch. A person can hold different roles at different branches of the same business (Manager at Branch 1, Cashier at Branch 2).

## Default role → permission mapping

See `seed_default_roles_for_business()` for the authoritative list. Summary:

| Role | Gets |
|---|---|
| Owner | every permission |
| Manager | products, inventory, purchasing, customers, sales (incl. void/refund, capped discounts), reports, financial view, expenses, `users.manage`, `audit.view`, `approvals.decide` — not `roles.manage` or `business.manage` |
| Cashier | product/customer view+edit, `sales.process`/`sales.hold`, capped `discounts.apply`, `inventory.view` — no refunds, no voids |
| Inventory Manager | products (view/create/edit), full inventory, purchasing, `reports.view` |
| Accountant | `financial.view`, reports, expenses, `audit.view`, supplier/customer view |
| Auditor | read-only: `audit.view`, `reports.view`, `financial.view`, product/inventory/customer/supplier view |

## Enforcement: three layers, deliberately redundant

1. **UI** hides actions the user can't take. Convenience only — never trusted.
2. **Server (real gate)**: every Server Action/Route Handler that mutates or reads sensitive data calls `requirePermission(supabase, businessId, permission)` or `requireBranchPermission(...)` (`lib/rbac/guard.ts`) before doing anything. These delegate to the same Postgres function RLS uses (`app_has_permission`/`app_has_branch_permission`), so the permission logic is defined once.
3. **Database (last line of defense)**: RLS policies (`0009_rls_policies.sql`) re-check the same thing regardless of what the application layer did. Verified directly in `tests/security/tenant_isolation_and_rbac.sql` — a Cashier session attempting `insert into roles (...)` is rejected by Postgres itself, not by application logic that happened to run first.

## Adding a new permission-gated action

1. If it's a genuinely new capability, add its key to the `permissions` catalog (new migration — the catalog is seed data, changed via migration, not by tenant admins) and to `PERMISSIONS` in `lib/rbac/permissions.ts`.
2. Decide which default roles should get it and add it to `seed_default_roles_for_business()` (new migration, or amend before this schema is ever deployed to a real project — once real businesses exist, changing which roles get a permission retroactively requires an `update role_permissions` migration, not editing the seed function after the fact).
3. Call `requirePermission()`/`requireBranchPermission()` at the top of the Server Action/Route Handler.
4. Add or extend an RLS policy on the affected table if it doesn't already check `app_has_permission()`.
5. Add a security test alongside `tests/security/tenant_isolation_and_rbac.sql` exercising the negative case (a role that shouldn't have the permission is blocked).

## Approval workflow (Section 30)

Designed (`docs/ARCHITECTURE.md` §6) as a single generic `approval_requests` table that discounts-over-cap, refunds, voids, and price changes all plug into — not yet implemented as a migration; lands with the POS/refunds phases that need it, since building it in isolation now would mean guessing its shape rather than deriving it from a real caller.
