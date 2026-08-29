# Busihub — Database

The SQL migrations in `supabase/migrations/` are the source of truth; this
document is a map of them plus the design decisions that don't fit as
inline comments. Every table and function below is also commented in its
migration file (`comment on table/function ...`), which is queryable
directly from `psql`/Supabase's SQL editor via `\d+ <table>` or
`select obj_description(...)`.

## Foundation-phase schema (this build)

```
businesses ─┬─< business_settings (1:1)
            ├─< branches
            ├─< roles ─< role_permissions >─ permissions (global catalog)
            ├─< user_branch_roles >─ branches, roles, profiles
            ├─< business_subscriptions >─ subscription_plans (global catalog)
            └─< audit_logs

auth.users (Supabase Auth) ─1:1─ profiles ─< user_branch_roles
```

| Migration | Contents |
|---|---|
| `0001_extensions_and_common.sql` | Extensions, shared `set_updated_at()` trigger |
| `0002_businesses.sql` | `businesses`, `business_settings` |
| `0003_branches.sql` | `branches` |
| `0004_profiles.sql` | `profiles` (1:1 `auth.users`) |
| `0005_rbac.sql` | `permissions`, `roles`, `role_permissions`, `user_branch_roles` |
| `0006_subscriptions.sql` | `subscription_plans`, `business_subscriptions` |
| `0007_audit_logs.sql` | `audit_logs` |
| `0008_auth_helper_functions.sql` | RLS helper functions (`app_has_permission`, etc.), `log_audit_event()` |
| `0009_rls_policies.sql` | RLS enabled + policies on every table above |
| `0010_seed_platform_catalog.sql` | The permission catalog and subscription plan catalog — real data, safe for production |
| `0011_business_registration.sql` | `register_business()`, `seed_default_roles_for_business()`, `set_cashier_pin()` |

Products, inventory, suppliers, customers, sales, payments, refunds,
expenses, receipts, notifications, and offline-sync tables are designed in
`docs/ARCHITECTURE.md` §4 and land as later migrations in their own
phases (see the roadmap in §12) — they are deliberately not included yet
so the foundation (tenancy + identity + RBAC + billing + audit) can be
verified in isolation first.

## Design decisions

**Every tenant table carries `business_id`, indexed, with an RLS policy
that scopes to it.** There is no table in this schema that trusts a
`business_id` supplied by the client — it's always resolved server-side
from the authenticated session via `app_current_business_id()` /
`app_has_permission()`.

**Two authorization layers.** RLS (in Postgres) is the last line of
defense; the Next.js server (later phases) is expected to also check
permissions before ever issuing a query, so a bug in one layer doesn't
leave the tenant boundary open. See `docs/RBAC.md`.

**Built-in roles are rows, not code.** `seed_default_roles_for_business()`
inserts real `roles`/`role_permissions` rows per business at registration.
An Owner can review and adjust what "Manager" grants for their business
without a code change — the six default role templates
(Owner/Manager/Cashier/Inventory Manager/Accountant/Auditor) only decide
the *starting* permission set.

**Money is `numeric(14,2)`, never `float`.** Currency arithmetic anywhere
in this schema uses exact decimal types; floating point is never used for
anything that touches a price, total, or balance (Section 22 of the
brief).

**Financial/audit immutability.** `audit_logs` has no UPDATE/DELETE
policy for any application role — see `0009`. The same immutability
pattern (no UPDATE policy once a row reaches a terminal state) will be
applied to `sales`/`payments` when those tables land, via a trigger that
rejects mutation of financial columns after `status = 'completed'`.

**Privileged column protection.** `profiles.is_super_admin`,
`profiles.business_id`, and `profiles.pin_hash` cannot be changed by the
otherwise-permissive "update your own profile" RLS policy — a trigger
(`prevent_protected_profile_changes`) blocks it unless a privileged
server-side function explicitly opts in via a session-local flag. This is
the concrete mechanism behind "never trust client-side role checks"
(Section 49): even a client that somehow issued a raw `update profiles set
is_super_admin = true` against a valid session token would be rejected at
the database layer.

**`SECURITY DEFINER` functions are the only way to bypass RLS from inside
the database**, and every one of them (`register_business`,
`set_cashier_pin`, `log_audit_event`, the `app_*` RLS helpers) either
derives everything from `auth.uid()` or performs its own explicit
authorization check before writing — see the comments on each function in
`0008`/`0011`.

## Running migrations

```bash
cp .env.example .env.local   # fill in SUPABASE_DB_URL (direct connection, not pooled)
npm run db:migrate
```

`scripts/db-migrate.mjs` tracks applied files in a `schema_migrations`
table and only runs new ones — safe to re-run. It requires the **direct**
Postgres connection string (Project Settings → Database → Connection
string → "Direct connection"), not the pgBouncer-pooled one, because
several migrations run DDL inside an explicit transaction.

## Seed data

`supabase/seed.sql` is development/test data only — a demo business, demo
owner login, and the seeded default roles. `npm run db:seed` refuses to
run against a connection string that doesn't look like a dev/local
project without an explicit typed confirmation. Never run it against
production (Section 47).

## Regenerating TypeScript types

Once a real Supabase project is connected, replace the placeholder in
`lib/supabase/database.types.ts`:

```bash
npx supabase gen types typescript --project-id <your-project-ref> > lib/supabase/database.types.ts
```

(Requires the Supabase CLI, which requires npm registry access — this
sandbox's network policy blocks that; run it from your own machine or CI.
See `docs/DEPLOYMENT.md`.)
