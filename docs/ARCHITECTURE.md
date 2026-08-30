# Busihub — Architecture

Status: **Phases 0–7 complete (see the roadmap below).** This document is
the living architecture reference for Busihub, a multi-tenant Point-of-Sale
and business-management SaaS for small retail businesses, built primarily for
the Ghanaian market with an extensible architecture for other countries.

It is written before most of the code so that every later phase builds on the
same model. It will be revised as real constraints surface — any revision is
called out in the Changelog at the bottom rather than silently rewritten.

---

## 1. Workspace assessment

The workspace was empty (no existing repo, package.json, or Supabase project)
at the start of this build. Busihub is greenfield. No existing functionality
is being replaced or removed.

---

## 2. System architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client (PWA)                             │
│  Next.js App Router (React 18, TypeScript, Tailwind)             │
│  - Server Components for data-heavy screens (reports, admin)     │
│  - Client Components for interactive POS/cart/offline logic      │
│  - Service Worker: asset caching + offline transaction queue     │
│  - IndexedDB: offline product cache, offline sale queue          │
└───────────────┬────────────────────────────────┬─────────────────┘
                │ HTTPS (RSC/fetch)               │ HTTPS
                ▼                                  ▼
┌─────────────────────────────┐      ┌─────────────────────────────┐
│  Next.js Server (Vercel)     │      │  Supabase Edge Functions     │
│  - Route Handlers /app/api   │      │  - Paystack webhook receiver │
│  - Server Actions            │      │  - Scheduled jobs (expiry,   │
│  - Auth/session (SSR cookies)│      │    low-stock digest)         │
│  - Zod validation             │      │  - Heavy/async work          │
│  - Business-rule enforcement  │      └───────────────┬───────────────┘
│  - Paystack init/verify calls │                      │
│  (holds all secret keys)      │                      │
└───────────────┬────────────────┘                      │
                │ service-role / RLS-scoped clients      │
                ▼                                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                          Supabase                                 │
│  PostgreSQL (RLS enforced on every tenant table)                  │
│  Supabase Auth (email/password, phone OTP, Google OAuth, MFA)     │
│  Storage (product images, logos, receipt PDFs, expense receipts)  │
│  Realtime (inventory/notification live updates)                   │
└─────────────────────────────────────────────────────────────────┘
```

**Why this shape.** Supabase gives us Postgres + RLS + Auth + Storage +
Realtime as one operationally simple backend, which matches "small business
SaaS" cost/complexity constraints far better than a hand-rolled
microservice backend. Next.js Route Handlers / Server Actions are the only
place that ever holds the Supabase **service role** key or the **Paystack
secret** key — the browser only ever gets the Supabase anon key plus RLS.
Anything security- or money-sensitive (price calculation, discount
authorization, payment verification, stock decrement) is re-derived and
re-validated server-side; the client's numbers are treated as a UI hint,
never as truth (Section 49 of the brief).

**Two authorization layers, deliberately redundant:**
1. **Application layer** (Next.js server): route/action-level permission
   checks, business rule enforcement (discount caps, approval workflows),
   request shaping.
2. **Database layer** (Postgres RLS): the last line of defense. Even if an
   application bug or a direct API call skips layer 1, RLS still blocks
   cross-tenant reads/writes. Tenant isolation must never depend on
   application code alone (Section 4, Section 49).

---

## 3. Folder structure

```
busihub/
  app/
    (marketing)/                 # public site: landing, pricing
    (auth)/                      # login, register, verify, reset
    (app)/                       # authenticated business app, tenant-scoped
      dashboard/
      pos/
      products/
      inventory/
      suppliers/
      customers/
      sales/
      refunds/
      expenses/
      reports/
      settings/
        business/ branches/ users/ roles/ payments/ receipts/ ...
    (super-admin)/                # separate, privileged surface
    api/
      paystack/webhook/route.ts
      paystack/verify/route.ts
      sync/route.ts               # offline queue ingestion
      ...
  components/
    ui/                           # design-system primitives (button, dialog…)
    pos/ products/ inventory/ reports/ ...
  lib/
    supabase/                     # server client, browser client, middleware
    auth/                         # session helpers, PIN auth, permission checks
    rbac/                         # permission constants, guards
    money/                        # currency/decimal-safe arithmetic
    offline/                      # IndexedDB queue, sync engine
    paystack/                     # server-only Paystack client
    validation/                   # zod schemas, shared client+server
    entitlements/                 # subscription/plan-limit resolution
  supabase/
    migrations/                   # numbered, immutable SQL migrations
    seed.sql                      # dev/test seed data (clearly marked)
  tests/
    unit/ integration/ e2e/ security/
  public/
    manifest.webmanifest
    sw.js (or generated)
    icons/
  docs/
    ARCHITECTURE.md (this file)
    DATABASE.md
    AUTH.md
    RBAC.md
    OFFLINE_SYNC.md
    PAYMENTS.md
    SECURITY.md
    DEPLOYMENT.md
    API.md
  .env.example
  .gitignore
```

Route groups separate the public marketing site, the authenticated
tenant-scoped app, and the Super Admin surface at the routing layer, so a
bug in one cannot accidentally render the other. The Super Admin surface
additionally never reuses tenant Supabase clients — it has its own
privileged, fully audited access path (Section 31).

---

## 4. Database architecture

Full column-level design lives in `docs/DATABASE.md` and the migration
files themselves (source of truth). Summary of the model:

**Tenancy root:** `businesses` → `branches` → almost everything else hangs
off `business_id` (always) and `branch_id` (where the concept is
branch-scoped: inventory, sales, POS terminals, expenses). Every tenant
table gets:
- `business_id uuid not null references businesses(id)`
- an index on `business_id` (and `(business_id, branch_id)` where relevant)
- an RLS policy scoping to the caller's business/branch

**Identity:** Supabase Auth's `auth.users` is the credential store; a
`profiles` table (1:1, `id = auth.users.id`) holds the business-domain
identity (name, business_id, status, PIN hash, etc.). We never duplicate
password handling — Supabase Auth owns that.

**RBAC:** `roles`, `permissions`, `role_permissions` (many-to-many),
`user_branch_roles` (a user can hold different roles per branch). Built-in
roles are seeded per business at creation time as real rows (not hardcoded
strings), so they can be viewed/extended, and custom roles are just more
rows in the same tables — no schema branching between "built-in" and
"custom" roles (Section 7).

**Money:** every monetary column is `numeric(14,2)` (or `bigint` minor
units where we want to be extra safe against float drift — decided per
table, documented inline), never `float`/`double`. Currency is stored
per-business (`businesses.currency`) and per-transaction, so multi-currency
is possible later without a rewrite.

**Financial immutability:** `sales`, `sale_items`, `payments` rows are
never UPDATEd after completion by application code (enforced by a trigger
that rejects mutation of financial fields once `status = 'completed'`).
Corrections happen via new rows: `refunds`/`refund_items` referencing the
original sale, `sale_voids` for pre-payment cancellation. This gives us a
true audit trail instead of "trust the audit log to have caught it."

**Inventory integrity:** stock quantity is never edited directly. Every
change is an `inventory_movements` row (reason, quantity delta, reference
to the sale/PO/adjustment that caused it) and the product/branch stock
level is a derived, trigger-maintained aggregate updated inside the same
transaction as the movement, using `SELECT … FOR UPDATE` row locking on the
stock row to prevent two concurrent sales from oversellng the same unit
(Section 10, Section 37).

**Idempotency:** offline sales carry a client-generated UUID
(`client_transaction_id`) with a unique constraint per business, so a
retried sync can never double-insert. Paystack webhooks are recorded in a
`payment_webhook_events` table keyed on Paystack's event id before being
processed, so a duplicate delivery is a no-op (Section 17, Section 37).

---

## 5. Authentication architecture

- **Primary identity**: Supabase Auth, email+password as the baseline,
  phone (OTP) and Google OAuth as additional sign-in methods on the same
  `auth.users` row where the user links them.
- **Session transport**: `@supabase/ssr` cookie-based sessions (httpOnly,
  secure, sameSite=lax), refreshed in Next.js middleware on every request —
  never a token held in `localStorage`.
- **MFA**: Supabase Auth TOTP enrollment, required for Owner/Super Admin
  roles by policy, optional (encouraged) for others.
- **Registration flow**: registering a business creates the `businesses`
  row, the first `profiles` row (Owner), and seeds default roles/permission
  grants in a single Postgres transaction (a Postgres function called from
  a Server Action) — never two separate unguarded inserts that could leave
  an orphaned business or ownerless account if one fails.
- **Email verification / password reset**: Supabase Auth's built-in flows,
  with our own branded email templates.
- **Cashier PIN workflow** (Section 6): this is a *second, lightweight*
  authentication layer on top of an already-authenticated device session,
  not a replacement for it.
  1. A manager/owner signs in normally (full Supabase Auth session) on a
     shared POS device and puts it into "register mode" for their branch.
  2. Cashiers pick their name from a branch-scoped list and enter a PIN.
  3. The PIN is verified **server-side** against a bcrypt/argon2 hash
     stored in `profiles.pin_hash` (never plaintext, never compared
     client-side) via a Route Handler that then mints a short-lived,
     narrowly-scoped Supabase session (or a signed server session cookie)
     for that cashier, carrying only POS-appropriate claims.
  4. PIN attempts are rate-limited and locked out after repeated failures,
     logged to the audit log like any other authentication event.
- **Failed-login protection**: Supabase Auth's own throttling plus an
  application-level check on `login_attempts`/audit log for
  business-specific lockout and alerting (Section 6, Section 29).
- **Device/session management**: users can view and revoke active sessions
  (Supabase Auth admin API from a trusted server context only).

Full detail in `docs/AUTH.md` once Phase 1 lands.

---

## 6. Authorization / RBAC architecture

- **Model**: role-based with granular permission strings
  (`products.create`, `sales.refund`, `discounts.apply.unlimited`, …),
  grouped into permission categories matching Section 7 of the brief.
- **Assignment**: a user has one or more roles **per branch**
  (`user_branch_roles`), so a manager at Branch 1 can be a cashier at
  Branch 2 if that's how the business actually runs.
- **Built-in roles** (Owner, Manager, Cashier, Inventory Manager,
  Accountant, Auditor) are seeded as real, business-scoped rows with a
  `is_system_role` flag — protected from deletion but editable in scope by
  an Owner if they want to adjust default permissions.
- **Custom roles**: same tables, `is_system_role = false`, created by
  anyone holding `roles.manage`.
- **Enforcement, three redundant places**:
  1. UI hides actions the user can't take (UX only, never trusted).
  2. Every Server Action / Route Handler calls a shared
     `requirePermission(supabase, permission, {businessId, branchId})`
     guard before doing anything — this is the real gate.
  3. RLS policies re-check business/branch scope (and, for a small set of
     high-risk tables, role) at the database layer regardless of what the
     application layer did.
- **Approval workflow** (Section 30) is a generic `approval_requests` table
  (requester, action type, resource type/id, payload, reason, approver,
  decision, timestamps) that discounts-over-limit, refunds, voids, and
  price changes all plug into the same way, rather than one-off tables per
  feature.

Full detail in `docs/RBAC.md`.

---

## 7. Offline synchronization architecture

- **Client cache**: on login, the POS caches the branch's active product
  catalog, prices, tax rules, and the cashier's own recent customers into
  IndexedDB, refreshed periodically and on reconnect.
- **Offline sale**: a sale created while offline is written to an
  IndexedDB `outbox` with a client-generated UUID
  (`client_transaction_id`), full line items, computed totals (recomputed,
  not trusted, on sync), and `status = 'pending_sync'`. Only cash and
  "record as owed/credit" payment types are permitted offline — anything
  requiring a live gateway call (Paystack) is blocked in the UI while
  offline.
- **Sync**: a background sync (Service Worker `sync` event, with a
  foreground fallback poll) POSTs queued sales to
  `/api/sync`, one batch call, each item keyed by its
  `client_transaction_id`. The server upserts against a unique constraint
  on `(business_id, client_transaction_id)` — replays are no-ops, not
  duplicates.
- **Conflict handling**: stock is validated and decremented at sync time
  inside the same row-locked transaction used for online sales; if stock
  is insufficient the sale still lands (a business shouldn't lose a sale
  that already happened in the shop) but the resulting negative-stock
  state is flagged and surfaced as an inventory alert, never silently
  auto-corrected in a way that hides it from the owner.
- **Status surfaced to the user**: an explicit online/offline indicator and
  a "N sales pending sync" counter with retry, never a silent queue.

Full detail in `docs/OFFLINE_SYNC.md`, implemented after the core online POS
is solid — building offline-first before the online path is proven is a
common way to end up with two half-working systems instead of one good one.

---

## 8. Payment architecture

- **Cash / mobile money (manual) / bank transfer**: recorded directly by
  the cashier, no external verification available — these are
  business-attested payments and are labeled as such in reports.
- **Paystack**: server holds the secret key only.
  1. Client asks the server to initialize a transaction
     (`/api/paystack/initialize`); server computes the authoritative
     amount from the sale it created server-side, never from a client-sent
     amount, and calls Paystack.
  2. Client completes payment via Paystack's inline/redirect flow.
  3. Server verifies via **both** a direct `GET /transaction/verify/:ref`
     call to Paystack **and** the webhook — a sale is only marked paid when
     Paystack, server-side, confirms it. The frontend reporting "success"
     is never sufficient (Section 17, Section 49).
  4. Webhook handler verifies the `x-paystack-signature` HMAC before
     touching the database, records the raw event in
     `payment_webhook_events` keyed by Paystack's event id (idempotency),
     and only then updates the payment/sale status.
- **Split payments**: a sale has one or more `payments` rows
  (`payment_allocations` if a single payment needs splitting across
  methods further), each independently tracked to completion; the sale is
  "fully paid" only when the sum of completed payments meets the total.
- **Customer credit/debt**: a payment method option that records the
  outstanding amount against the customer's account rather than an
  external gateway.

Full detail in `docs/PAYMENTS.md`.

---

## 9. Subscription / entitlement architecture

- `subscription_plans` (platform-level, Super-Admin managed): name, price,
  billing interval, and a `limits` jsonb column (`max_users`,
  `max_branches`, `max_products`, `max_pos_terminals`, feature flags like
  `advanced_reports`, `storage_mb`, …) — **no plan limit is ever hardcoded
  in application code**; every gate reads this row.
- `business_subscriptions`: which plan a business is on, `status` (trial,
  active, past_due, suspended, cancelled, expired), period dates.
- A single `lib/entitlements` module resolves "can this business do X right
  now" by reading the plan's `limits` jsonb plus a live count (e.g.
  `current branch count < limits.max_branches`), and every place that
  creates a branch/user/product/terminal calls it before writing — again,
  both as a friendly UI-level pre-check and as a hard server-side check.
- Status transitions (trial → active, active → past_due, etc.) are driven
  by scheduled Edge Functions checking billing state, not by ad hoc writes
  scattered through the app.

Full detail folded into `docs/DATABASE.md` (subscription tables) as this
lands.

---

## 10. Security architecture

- **Tenant isolation**: RLS on every tenant table, tested explicitly
  (Section 39's security tests) with a second business's credentials
  attempting to read/write the first business's rows.
- **Secrets**: Supabase service-role key, Paystack secret key, and any
  other server secret live only in server-side environment variables
  (Vercel project env vars in production, `.env.local` — gitignored — in
  development), never in client bundles, never committed. `.env.example`
  documents every variable with a placeholder, no real values.
- **Input validation**: `zod` schemas shared between client (form
  validation, fast feedback) and server (the actual gate) for every
  mutation.
- **Output/XSS**: React's default escaping, plus explicit sanitization
  anywhere HTML is rendered from user input (e.g. rich receipt footers).
- **SQL injection**: no raw string-concatenated SQL; Supabase client /
  parameterized queries / Postgres functions with typed arguments only.
- **CSRF**: SameSite=lax session cookies plus Next.js Server Actions'
  built-in origin checks; state-changing Route Handlers additionally verify
  origin.
- **Rate limiting / brute force**: login, PIN entry, and password reset
  endpoints are rate-limited (Upstash Ratelimit or a Postgres-backed
  counter, decided in Phase 1) per IP and per account.
- **Security headers / CSP**: set in `next.config.js` /
  middleware — `Content-Security-Policy`, `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`.
- **File uploads**: type allow-list, size limits, stored in Supabase
  Storage buckets with their own RLS/policy, never served from a path an
  attacker can control.
- **Webhook verification / idempotency**: covered in Section 8.
- **Audit logging**: covered by the `audit_logs` table (Section 28),
  written by the same server-side guard functions that enforce
  permissions, so "was this authorized" and "was this logged" can't drift
  apart.
- **Error handling**: a single server error boundary converts any
  unexpected exception into a generic message + a server-side log entry;
  raw Postgres/Supabase errors are never forwarded to the client.

Full detail in `docs/SECURITY.md`.

---

## 11. Testing strategy

- **Unit** (Vitest): money/tax/discount math, permission-resolution logic,
  entitlement checks, inventory math — pure functions, no I/O.
- **Integration** (Vitest + a real local/test Supabase project): auth
  flows, RLS policies (cross-tenant negative tests), sale creation,
  payment verification, webhook handling, sync idempotency.
- **End-to-end** (Playwright): the full scenario in Section 39 — register
  business → branch → user → role → product → stock → cashier login → scan
  → cart → cash sale → receipt → inventory reduction → manager refund →
  inventory restoration — plus the offline-sale-then-reconnect scenario.
- **Security tests**: explicit adversarial tests — cross-tenant access
  attempts, privilege escalation attempts (a cashier calling a
  manager-only endpoint directly), expired/invalid tokens, webhook
  signature spoofing, duplicate payment/sync replay.
- Tests are added **alongside** each phase, not deferred to the end; a
  phase in the roadmap below is not "done" until its tests exist and pass,
  per the brief's completion definition in Section 2.

Full detail in `docs/TESTING.md` as the harness is set up in Phase 1.

---

## 12. Development phases (roadmap)

Matches the lifecycle in Section 2 of the brief, ordered so each phase only
depends on ones before it. Status is updated as work lands — this is the
one section of this document expected to change often.

| Phase | Scope | Status |
|---|---|---|
| 0 | Architecture, folder structure, tooling scaffold | **done** |
| 1 | Core database schema + RLS foundation (business, branch, profiles, RBAC, subscriptions, audit) | **done — verified, see tests/security/** |
| 2 | Authentication (registration, login, sessions, PIN storage) | **done** (PIN entry UI/route deferred to POS phase; MFA/phone/Google deferred — see docs/AUTH.md) |
| 3 | Authorization/RBAC enforcement layer | **done — verified, see tests/security/** |
| 4 | Business & branch management UI/API | **done — verified end-to-end on a real machine + CI** |
| 5 | Products (incl. variants, barcodes) | **done — verified, see tests/security/ + live browser testing** |
| 6 | Inventory (stock levels, movements ledger, receive/adjust/count) | **done — verified, see tests/security/inventory.sql** (transfers & low-stock alerts deferred) |
| 7 | Suppliers & purchasing (POs, approval, partial receipts) | **done — verified, see tests/security/purchasing.sql** (supplier price lists deferred) |
| 8 | Customers | pending |
| 9 | POS core (online, cash) | pending |
| 10 | Payments incl. Paystack | pending |
| 11 | Receipts / printing | pending |
| 12 | Refunds & voids | pending |
| 13 | Expenses | pending |
| 14 | Reports | pending |
| 15 | Notifications | pending |
| 16 | Offline/PWA | pending |
| 17 | Synchronization | pending |
| 18 | Subscriptions & entitlements enforcement | pending |
| 19 | Super Admin | pending |
| 20 | Audit/security monitoring surfaces | pending |
| 21 | Automated test suite hardening | pending |
| 22 | Security review pass | pending |
| 23 | Performance review pass | pending |
| 24 | Deployment prep & documentation | pending |

**This session's committed scope**: Phases 0–3 (architecture, schema, RLS,
auth, RBAC enforcement) to genuine production quality, forming the
foundation everything else is built on. Later phases continue in follow-up
work, phase by phase, with the same bar — implemented, tested, and verified
before being called done, per Section 2's completion definition.

---

## Changelog

- 2026-08-30 — Phase 7 (suppliers & purchasing) complete. Migration 0016
  adds `suppliers`, `purchase_orders` and `purchase_order_items`, and
  closes the loop with Phase 6: receiving against an approved order writes
  the `inventory_movements` rows itself, tagged with
  `reference_type='purchase_order'`, so stock that arrived this way is
  traceable to a supplier, a price and an authorisation. Agreed scope:
  approval required before receiving, partial deliveries allowed.
  Enforcement is in the database — `enforce_purchase_order_rules()`
  validates the status machine (rejecting e.g. draft→received or reviving
  a cancelled order), requires `purchase_orders.approve` to approve or
  cancel and `inventory.receive` to move into a received state, and
  freezes an order's terms and lines once it leaves draft; a
  `quantity_received <= quantity_ordered` constraint refuses
  over-receipts; `receive_purchase_order()` does the whole delivery in one
  transaction. Verified against Postgres — `tests/security/purchasing.sql`
  (24 assertions incl. approval bypass via raw UPDATE, over-receipt
  rollback, frozen approved orders, cancellation being terminal,
  per-business PO numbering, and cross-tenant isolation). Wired into CI.
- 2026-08-30 — Hardened both new security suites after finding they could
  report a false PASS: `raise exception 'TEST FAILED'` defaults to
  SQLSTATE P0001, which several blocks also catch as the *expected*
  rejection — so an operation that wrongly succeeded would have had its
  own failure message swallowed and printed as a pass. All such raises now
  carry a SQLSTATE no handler catches. Confirmed by deliberately breaking
  three guarantees (the approval permission check, the over-receipt
  constraint, and the negative-stock guard) and checking each suite fails
  with a non-zero exit — it does; before the fix, the first would have
  passed.

- 2026-08-30 — Phase 6 (inventory, core stock tracking) complete. Migration
  0015 adds an append-only `inventory_movements` ledger plus a
  trigger-maintained `stock_levels` aggregate, implementing the "stock is
  never edited directly" rule from §Inventory integrity above. Enforcement
  is at the database, not the app: `stock_levels` has its insert/update/
  delete grants revoked entirely (its only writer is the SECURITY DEFINER
  `apply_inventory_movement()` trigger), `inventory_movements` has its
  update/delete grants revoked so the ledger is genuinely append-only, and
  the RLS insert policy is per-`reason` so `inventory.receive` and
  `inventory.adjust` stay separately enforced while the reasons reserved
  for later phases (`sale`, `transfer_*`) are rejected outright.
  `record_stock_count()` converts an absolute physical count into a
  relative movement under an advisory lock, because computing that delta
  in application code is a read-then-write race. Verified directly against
  Postgres — `tests/security/inventory.sql` (21 assertions: accumulation,
  business_id/created_by spoofing, negative-stock rejection, reserved
  reasons, direct-write refusal on both tables, cashier permission split,
  cross-tenant isolation, and ledger↔level reconciliation), plus a real
  concurrency run (8 parallel workers, 243 mixed count/receive movements)
  confirming zero lost updates and exact reconciliation. Wired into CI.
- 2026-08-30 — Fixed a validation bug reachable since Phase 5: numeric form
  fields used `z.coerce.number()`, which is `Number(input)` underneath, and
  `Number("")`/`Number(null)` are a finite `0`. A blank selling price
  therefore parsed as a deliberate zero and created a free product, and the
  same shape would have let a blank stock count silently zero an item's
  stock. Replaced with `lib/validation/numeric.ts`'s `decimalField()`,
  which rejects blank/non-numeric input and refuses more precision than the
  destination column stores (so Postgres never silently rounds a figure the
  user typed). Cost price keeps blank-means-zero, but deliberately and in
  one place. Locked in by tests/unit/products-validation.test.ts.

- 2026-08-29 — Initial architecture document, Phase 0.
- 2026-08-29 — Phases 0–3 complete: project scaffold, full tenancy/identity/RBAC/subscriptions/audit schema with RLS (migrations 0001–0011), authentication flows (register/login/logout/reset), RBAC enforcement layer (`lib/rbac`). Tenant isolation and RBAC enforcement verified directly against Postgres — see `tests/security/tenant_isolation_and_rbac.sql`. `npm install`/`build`/`lint`/`typecheck` not run locally (sandbox network restriction — see `docs/DEPLOYMENT.md`); wired into CI to run on every push instead.
- 2026-08-30 — Phases 0–3 verified end-to-end against a real environment, closing out every item that the previous entry had to leave as "not run locally": `npm install`/`typecheck`/`lint`/`test` (20/20 unit tests)/`build` all run and passed on a real Windows machine, after fixing a Next.js 14→16 + ESLint 9 upgrade forced by `npm audit` (flat-config migration, `middleware.ts`→`proxy.ts` rename, removed `next lint`, `@types/node` peer bump). All 11 migrations applied to the real Supabase project via `npm run db:migrate` (session pooler — the direct-connection host is IPv6-only and doesn't resolve on all networks). Full registration flow proven live: `/register` → confirmation email → `app/auth/confirm/route.ts` (the PKCE code-exchange callback, previously missing entirely — the email link would confirm the address but never sign the user in) → `register_business()` → an RLS-scoped `/dashboard` render, fixing an ambiguous `profiles`→`businesses` PostgREST embed (`PGRST201`, two FKs between the same tables) along the way. Repository pushed to GitHub for the first time (`macfelix13/busihub`); all three CI jobs (`database`, `app`, `deploy-migrations`) passing on GitHub's runners. `react`/`react-dom` confirmed consistent at `18.3.1` throughout the dependency tree (`npm ls`) — no React 19 mismatch. Foundation phase (0–3) is now genuinely done per Section 2's completion definition: implemented, tested, and verified — not merely written.
