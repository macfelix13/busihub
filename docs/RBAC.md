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

## Services reuse products.* — no new permission set

`supabase/migrations/0040_services.sql` adds services (braiding, sewing, barbering...) as products with
`type = 'service'` — same table, same variants, same catalog. Managing a service (create/edit/archive/change price)
is gated by the exact same `products.view`/`products.create`/`products.edit`/`products.archive`/`products.change_price`
permissions a product already uses — **there is no `services.*` permission set**, and none is planned.

This was a deliberate choice, not an oversight: `seed_default_roles_for_business()` (0011) only ever runs once, at
business registration, and this project has never yet added a new permission to the catalog after the initial
`0010_seed_platform_catalog.sql` seed. Introducing a `services.*` set would have meant every already-registered
business's Owner/Manager/etc. roles silently lacking it until a separate backfill migration touched every tenant's
`role_permissions` rows — a kind of migration this codebase has no precedent for and no tooling built around. Reusing
`products.*` means every existing business's staff permissions extend to services with zero backfill required.

One consequence worth naming: a custom role that was given `products.view`/`products.create` etc. *without* wanting
staff to also manage services has no way to separate the two — granting one still grants the other, by construction.
That's the accepted trade-off for not having to run a permission backfill on every tenant; if it becomes a real
problem, splitting `services.*` out later is a normal (if now-first-of-its-kind) backfill migration, not a redesign.

`sale_items.rendered_by` — who actually did the work on a service line — is **not** part of this permission story at
all. It is business metadata, not an authorization boundary, and it is intentionally unlike `cashier_id` (see below):
`create_sale()` requires and validates that a named renderer is an *active member of the caller's own business*
(tenant isolation only), never that they hold any particular permission — per this feature's own design decision,
any active staff member can be named, since naming someone grants no privilege and unlocks no data. Contrast this
with `cashier_id`, which **is** an authorization-adjacent value (0039 requires it to be the caller themselves,
enforced with a `42501` hard error on mismatch) because it decides RLS visibility of the sale. Confusing the two —
i.e., ever adding an auth check to who can be named as a renderer — would be a step backward from the design the
user explicitly chose.

## Staff management

Built in `supabase/migrations/0036_staff_management.sql` — see `docs/AUTH.md`'s "Staff invite flow, in detail" for
the full walkthrough. Three `SECURITY DEFINER` functions, each re-deriving the caller's own `business_id` from their
own profile rather than accepting one as an argument, so there is no way to act on a business other than the
caller's own no matter what a tampered request claims:

- `invite_staff_member()` — called by `app/(app)/settings/staff/actions.ts` right after Supabase Auth Admin's
  `inviteUserByEmail()` creates the account. Creates the profile and the branch/role assignment.
- `update_staff_role()` — replaces (or, given a null role, removes) a colleague's role at one branch.
- `set_staff_status()` — activates/deactivates a colleague's account; enforced at `app/(app)/layout.tsx`.

All three require `users.manage`, all three refuse to let a caller act on their own row, and granting (or moving
someone into) the Owner role additionally requires `business.manage` — otherwise a Manager (who holds `users.manage`
but not `business.manage`) could invite a new colleague and directly outrank themselves. `update_staff_role()` and
`set_staff_status()` also refuse a change that would leave the business with zero active Owner-role holders.
Exercised in `tests/security/staff_management.sql`.

**Deliberately out of scope for this phase**: creating or editing custom roles/permissions through the UI (the
`roles.manage` permission and the underlying schema support it — see "Model" above — but the Staff pages only let an
Owner/Manager assign the six built-in roles to a colleague, not define new ones).

## A Cashier's own sales, refunds and payments only

`supabase/migrations/0037_cashier_own_sales_visibility.sql` (with a numbering fix in `0038_fix_numbering_after_cashier_rls.sql`) narrows what `sales.process` alone can read. Before 0037, `sales_select`/`sale_items_select`/`refunds_select`/`refund_items_select`/`sale_payments_select` granted full, business-wide read access to anyone holding `sales.process` OR `reports.view` — meaning a plain Cashier (who holds `sales.process` but not `reports.view`) could read every sale, refund and payment ever rung up by every colleague, not just their own till.

The fix, entirely at the RLS layer (never trust a page's query alone to hide rows — see `docs/SECURITY.md`):

- **`reports.view` holders (Manager, Owner, Accountant, Auditor by default) are unaffected** — they still see the whole business, unrestricted.
- **A `sales.process`-only holder (the default Cashier role) now sees only rows tied to their own `cashier_id`.** Before `0039_till_pin_self_only.sql`, `cashier_id` was the PIN-verified identity at the till (`lib/auth/till-session.ts`), which was not necessarily whoever was logged into the browser (`created_by`/`auth.uid()`) on a shared device. 0039 closed that gap: `create_sale()`/`create_refund()` now always set `cashier_id := auth.uid()`, so for every sale and refund made from that migration forward, `cashier_id` and `created_by` are the same account by construction — there is no longer any way for them to diverge. `sale_items`/`refund_items`/`sale_payments` (which have no `cashier_id` of their own) are scoped by joining back to the sale/refund that owns them.
- Reachable directly by the browser client with the caller's own valid session — not just gated by a page's query — so this cannot be bypassed by querying Supabase directly.

**Historical note — the shared-till mismatch this section used to warn about can no longer happen going forward:**

- Before 0039, "Who's at the till? Pick your name" let anyone logged into the browser type a *colleague's* PIN and have the sale attributed to that colleague instead of whoever was actually signed in — the paragraph that used to live here documented the resulting `cashier_id`/`created_by` split as a known, deliberate limitation. 0039 replaced that flow: the PIN pad only ever checks the signed-in account's own PIN (`verify_profile_pin(p_pin)` — no parameter names anyone else), and handing the till to a colleague is now a real password sign-in ("Switch user", reusing the login page's own `signInWithPassword` mechanism). Sales and refunds recorded **before** 0039 was applied may still show a `cashier_id` that differs from `created_by`; nothing new can.
- A hypothetical custom role combining `sales.refund` with `sales.process` but *without* `reports.view` can no longer refund a colleague's sale: `create_refund()` reads both the original sale and its `sale_items` under the caller's own RLS, so both reads fail for a sale that isn't the caller's own. Neither built-in role is affected — Manager already holds both `sales.refund` and `reports.view`.
- The receipt/refund history page a customer's receipt links to (`app/(app)/sales/[id]/receipt/page.tsx`) relies on the same RLS, so a Cashier can only reprint/view a receipt for a sale that was their own (or with `reports.view`).
- `next_receipt_number()`/`next_refund_number()` (0038) are narrow `SECURITY DEFINER` helpers that compute the next sequence number across *every* sale/refund regardless of the caller's own visibility — required so two cashiers on the same shift don't collide on the same receipt number, but otherwise return a bare number, never row data, so they don't reopen the visibility 0037 narrowed.

## Approval workflow (Section 30)

Designed (`docs/ARCHITECTURE.md` §6) as a single generic `approval_requests` table that discounts-over-cap, refunds, voids, and price changes all plug into — not yet implemented as a migration; lands with the POS/refunds phases that need it, since building it in isolation now would mean guessing its shape rather than deriving it from a real caller.