# Busihub — Architecture

Status: **Phases 0–12 complete (see the roadmap below).** This document is
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
| 8 | Customers (contacts + credit accounts) | **done — verified, see tests/security/customers.sql** (loyalty points deferred) |
| 9 | POS core (cash + credit, PIN till login) | **done — schema verified (tests/security/sales.sql); till UI needs browser verification** |
| 10 | Payments incl. Paystack | **done — verified, see tests/security/payments.sql** (mobile money via each shop's own Paystack account; card & bank transfer deferred) |
| 11 | Receipts / printing | **done — printed + shareable text; QR and public receipt links deferred** |
| 12 | Refunds & voids | **done — verified, see tests/security/refunds.sql** (brought forward ahead of Phase 10/11; exchanges deferred) |
| 13 | Expenses | **done — verified, see tests/security/expenses.sql** (no approval workflow and no recurring expenses, both by decision; see 0031's header) |
| 14 | Reports | partial — the dashboard's analytics (0030) and the expense summaries (0031) are verified; standalone report pages, exports and a full P&L still pending |
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

- 2026-08-31 — Phase 13: expenses, and a net profit that means something.

  Gross profit (0029) is sales less what the goods cost. Net profit is
  that less rent, wages, light and water — which Busihub had nowhere to
  record until now, which is why the dashboard was careful to label its
  profit figure "before expenses". `expenses` and `expense_categories`
  (0031) close that, and the dashboard's third KPI is now Net profit,
  shown **only** to someone who can see both halves: a person with
  reports.view but not expenses.view would otherwise be handed gross
  profit under a net-profit label, which is the exact mislabelling the
  previous phase went out of its way to avoid.

  **Three decisions, taken deliberately and recorded in the migration
  header.** An expense counts the moment it is recorded — no approval
  queue, because a queue nobody empties makes "this month's profit" wrong
  until someone remembers to click. No recurring-expense machinery: rent
  is typed each month, because posting money into the books that nobody
  agreed to is worse than a figure arriving late. And an expense records
  WHERE the money came from, which is the one that earns its keep: a
  cashier paying the water bill out of the till is the commonest reason a
  drawer comes up short, and `cash_drawer_summary()` now says takings in,
  cash expenses out, what should be there.

  `expenses.approve` had no approval left to authorise, so rather than
  leaving a permission describing a workflow that does not exist, its
  catalog description was corrected to what it now gates: voiding an
  expense and shaping the category list. Recording one is
  `expenses.create`, and the two being separate is what stops a clerk
  making last month's rent disappear.

  **Nothing is deleted and nothing is edited.** A mistake is voided with
  a reason; it stops counting and stays on the page. The amount and date
  are not updatable at all — `revoke update on expenses` first, then
  `grant update (status, voided_by, voided_at, void_reason)`, because a
  table-level grant authorises every column regardless of any per-column
  revoke (the same trap as `profiles.pin_hash` in 0018). The test for
  that runs as the OWNER, since testing it as someone the policy already
  refuses would prove nothing.

  25 assertions in `tests/security/expenses.sql`, and nine sabotages each
  confirmed to fail it — including running `expense_summary` as
  `SECURITY DEFINER`, which tells a cashier what the shop spent, and
  dropping the `if not found` raise from `void_expense`, which tells a
  clerk the rent has been cancelled when it has not.


- 2026-08-31 — Cost of goods (0029) and the dashboard's analytics (0030).

  **Gross profit is now a real number.** `sale_items` gained `unit_cost`,
  captured from the catalog at the moment of sale, and `refund_items`
  carries that same cost back out when goods are returned. This is the
  load-bearing decision in 0029: reading cost from today's catalog would
  mean a supplier raising his price next month silently rewrites last
  month's profit. The test that proves it trebles a variant's
  `cost_price` after the sale and asserts the recorded figure did not
  move; sabotaging `create_sale` to skip the capture, or `sales_summary`
  to join the live catalog, both fail it. Sales rung up before 0029 were
  backfilled from the current catalog and flagged
  `cost_is_estimated` — surfaced on the dashboard in words rather than
  quietly averaged in.

  **Six analytics functions** (0030), every one `SECURITY INVOKER` so RLS
  scopes the total: `sales_trend` (gap-filled buckets in the shop's own
  timezone), `payment_method_breakdown` (from the tender ledger, cash net
  of change given, verified tenders only), `top_products` (net of
  returns), `low_stock_report` (out / critical / low against a per-variant
  reorder point), `staff_performance` and `branch_performance`.
  `tests/security/dashboard.sql` adds 11 blocks, half of them about the
  figure being right and half about it being *theirs*, plus a catalog
  assertion that none of the reporting functions is `SECURITY DEFINER` —
  the one-word change that would turn every isolation assertion into the
  only thing standing between a shop and its neighbour's takings.
  Sabotaging `sales_trend` to `DEFINER` shows the second business
  GH₵4,170 it never took.

  **The dashboard** now filters by period and branch through the URL,
  charts sales and gross profit as server-rendered SVG (no charting
  library, no client JavaScript), and adds payment mix, best sellers by
  profit, low stock by severity, staff and branch tables. Period
  boundaries are computed in the branch's timezone, not the server's:
  Ghana is UTC+0, so a server-time "today" would be invisibly correct
  here and wrong for the first business outside that offset, on the figure
  people check most. `tests/unit/dashboard-period.test.ts` pins that
  against Auckland and New York.

  **Still absent, deliberately:** net profit, expense totals and margin
  after costs. There is no expenses table until Phase 13, so a "net
  profit" here would be gross profit with a misleading label on a screen
  people price goods from. Gross profit is labelled "before expenses".

  A fixture-order bug fixed on the way: `tests/security/refunds.sql`
  asserted a literal `RF-000001`, which quietly made it depend on no
  earlier suite creating a refund. The moment `sales.sql` grew one, it
  failed. The assertion now derives the expected number the same way the
  database does — suite order must never be load-bearing.

- 2026-08-31 — A real dashboard, and a fix for multi-minute compiles.

  **Compiles.** `next dev` was logging `Watchpack Error (initial scan):
  EINVAL … lstat 'F:\System Volume Information'` — Next had inferred the
  workspace root as the DRIVE, not the project, so the file watcher was
  scanning all of `F:\` (Windows system folders included) at startup and
  on every change. `turbopack.root` and `outputFileTracingRoot` are now
  pinned to the project directory. The remaining cost is environmental:
  the project lives on `F:`, and Next itself reports the filesystem as
  slow.

  **Dashboard.** Replaces the foundation-phase placeholder. What needs
  doing comes before what merely happened: a banner for sales still
  waiting for payment (they are holding stock off the shelf) and for
  products at or below the low-stock threshold, then today's and this
  month's net takings, what was returned, and what customers owe, then the
  latest sales. `dashboard_snapshot()` (0028) computes the counts in the
  database for the same reason `sales_summary()` does — a total assembled
  from whatever rows a page fetched is not a smaller truth, it is a false
  one. Money figures need `reports.view`: processing sales does not imply
  being trusted with the day's takings.

  Two sabotages confirm the assertions: as `SECURITY DEFINER` the second
  test business is shown GH₵200 of debts it is not owed, and summing
  balances unconditionally lets a customer in credit silently reduce what
  everyone else owes.

- 2026-08-31 — Sales history at `/sales`: every sale newest-first, with
  status tabs, a date range and receipt-number search that all live in the
  URL so a particular day can be bookmarked or sent to someone, plus
  paging at 50.

  The takings line above it is computed in the database
  (`sales_summary()`, migration 0027) rather than by adding up the visible
  rows — adding up a page would report "today: GH₵240" when today was
  GH₵3,000 across four pages, and a wrong total on a money screen is worse
  than no total. It counts only **completed** sales: voided, cancelled and
  still-awaiting-payment sales stay in the list, because a history that
  hides them is not a history, but counting them as takings would
  overstate the day silently.

  The function is `SECURITY INVOKER` on purpose, so the same RLS that
  decides which sales a person may list decides which they may total.
  Sabotaging it to `SECURITY DEFINER` makes the suite fail with the other
  business totalling GH₵2,550 it does not own — which is the assertion
  earning its place.

- 2026-08-30 — Phase 11: receipts. `/sales/[id]/receipt` prints a slip
  sized to the shop's paper setting — 32 characters on a 58mm roll, 42 on
  80mm, 60 on A4 — with the shop name, address, cashier, every tender, and
  the configured footer.

  The printed slip and the "copy for WhatsApp" text are **the same
  string**, not two layouts that resemble each other, so they cannot
  quietly disagree about a total. That string comes from a pure function
  (`lib/receipts/format.ts`) because receipt layout is arithmetic —
  columns aligned inside a fixed character width — and arithmetic inside a
  React component is arithmetic nobody tests. 26 assertions cover it,
  including that no line ever exceeds the roll and every amount sits flush
  to the right edge. Writing those tests immediately found a real bug: a
  long product name overflowed the width, which does not fail visibly on
  screen — it just prints wrong.

  Two things deliberately NOT built. There is no "send to customer"
  button: sending means a receipt anyone with the link can open, an
  unauthenticated page showing what someone bought and paid, which is a
  privacy decision deserving its own design rather than being added in
  passing. And the QR setting is saved but not printed — a code is only
  worth scanning once there is a link for it to point at — with a note
  beside the setting saying so, rather than a checkbox that silently does
  nothing.

- 2026-08-30 — **Do not migrate `useFormState` to `useActionState`.**
  Attempted and reverted. React 18.3.1 emits a deprecation warning in the
  console on every form page ("ReactDOM.useFormState has been renamed to
  React.useActionState") — that is 18.3's job, warning about React 19 —
  but `useActionState` does **not exist** in React 18, so acting on the
  warning breaks all 20 form components at once. `npm ls react react-dom`
  is the check; `package.json` alone is not, since a pin can drift from
  what is installed. The rename becomes correct only after React 19 is
  actually installed, and `useFormStatus` stays in react-dom either way.

- 2026-08-30 — Opening stock on the new-product form (0026). A new product
  used to start at zero, so putting an existing shelf into Busihub meant
  visiting /inventory/receive again for every product. There is now a
  quantity box per variant and a branch selector that appears only once
  there is stock to place.

  It is not a way to write a stock level. Opening stock becomes a real
  `receive` movement in the same ledger as every other movement, in the
  same transaction as the product — so a product either exists with its
  stock or does not exist at all, and "where did these 40 bags come from?"
  still has a row with a date and a person on it. `create_product` still
  runs as the caller, so it goes through the inventory ledger's own RLS:
  a Cashier who may add products but not receive stock is refused, which
  is asserted rather than assumed. The product page also shows current
  stock per branch, read-only, and only to someone holding
  `inventory.view` — RLS would otherwise filter the rows away silently
  and the column would read "none" for a fully stocked product.

  `tests/security/opening_stock.sql` adds 9 assertions — **191 across
  nine suites** — including that the old eight-argument `create_product`
  call still works and invents no stock.

- 2026-08-30 — Fix (0025): every mobile money sale was refused in the
  browser with "Every payment needs an amount greater than zero", while
  all 179 database assertions stayed green.

  `jsonb -> 'key'` returns SQL NULL only when the key is **absent**. A key
  present holding a JSON null returns the jsonb value `null`, which is not
  SQL NULL — so `(v_pay -> 'amount') is null` was false for the
  `{"amount": null}` that `JSON.stringify` actually sends, execution fell
  through to the branch that reads the amount, and the sale was refused.

  The tests missed it because they build payloads with
  `jsonb_build_object` and simply omit the key: they were testing a shape
  the application never sends. Both spellings are now accepted
  (`jsonb_typeof`), the till omits the key rather than nulling it, and
  three assertions send exactly what the browser sends. Reverting the fix
  reproduces the browser error, which is how the assertions were checked.

- 2026-08-30 — Phase 10, part 3: mobile money at the till. The payment
  selector now offers Cash, Mobile money, Cash + mobile money, or On
  account — and hides the momo options entirely unless the shop has both
  switched it on and connected an account, because a button that can only
  fail is worse than no button.

  The till still names exactly one money figure: the cash in the drawer.
  Migration 0024 lets a momo tender arrive with no amount, meaning
  "whatever the cash did not cover", worked out by create_sale from prices
  it read itself. Without that the till would have to state the charge
  from its own preview — which it cannot know is right, and which would
  let a tampered client prompt a customer's phone for a figure of its own
  choosing.

  Order matters in completeSale: the sale is created FIRST, which commits
  the stock and produces the reference Paystack quotes back, and only then
  is the phone prompted. Charging first would mean holding a successful
  payment with nothing to attach it to. If the charge cannot be started,
  the sale is cancelled so it is not left holding stock, and the error is
  returned rather than redirected — which also leaves the cart on screen
  so the cashier can fix the number and try again.

  The receipt then shows a live waiting panel: the webhook normally
  settles within a second or two, but it can be slow or misconfigured and
  a cashier cannot stand there wondering, so the page also asks Paystack
  directly every four seconds. Both routes settle through the same
  database function, so whichever arrives first wins. `business_momo_enabled()`
  exposes one bit to the till rather than widening the settings policy —
  a cashier answering "can we take momo?" should not be handed the keys to
  read it. 179 database assertions across eight suites; 152 unit tests.

- 2026-08-30 — Phase 10, part 2: connecting Paystack. Each shop pastes its
  own keys at `/settings/payments`; the secret is encrypted with
  AES-256-GCM before it reaches the database under a key held only in the
  server's environment, and the ciphertext column is unreadable by any
  ordinary user (see docs/SECURITY.md). Live vs test is read off the key
  prefix rather than asked for, so a shop cannot believe it is taking real
  money when it is not.

  The webhook lives at `/api/webhooks/paystack/[businessId]` — per
  business, because with per-shop keys there is no single secret to verify
  against. Three things it is careful about, each of which was a bug in
  the first draft: the signature is computed over the **raw** body (re-
  serialising parsed JSON changes the bytes and breaks honest requests); a
  transient settlement failure **withdraws** the replay-guard row, because
  recording the event first and returning 200 on every retry would have
  lost the settlement permanently; and a reference that is not one of our
  UUIDs is acknowledged rather than settled, because a shop's own Paystack
  account also sends us events for payments Busihub never created.

  Migration 0023 closes a cross-tenant hole in 0022 found while wiring
  this up: `settle_sale_payment()` took a payment id and nothing else, so
  a shop could sign a valid `charge.success` for a reference belonging to
  someone else's sale. It now takes the business id the signature proved
  and refuses anything outside it. The same migration backfills a tender
  row for every sale that predates the ledger, so "how was this paid for?"
  covers all of history rather than starting today. 175 assertions across
  eight database suites, plus 20 new unit tests for the encryption and the
  signature check.

- 2026-08-30 — Phase 10, part 1: the payments ledger and the sale
  lifecycle. Mobile money is not paid instantly — the customer approves a
  prompt on their own phone and the answer arrives on a webhook seconds
  later, or never — so a sale now has a lifetime: `awaiting_payment` →
  `completed` → `voided`, or `awaiting_payment` → `cancelled`. Tenders
  became their own append-only rows (`sale_payments`), which is what makes
  "GHS 50 cash and the rest on momo" expressible at all; `payment_method`
  on the sale is now a summary of them.

  The load-bearing decision is that **stock leaves the shelf when the cart
  is rung up, not when the money lands**. The alternative loses: two tills
  could both promise the last bag of rice, and the second customer would
  have paid before anyone discovered it was gone. Committing the goods up
  front means a payment that succeeds can always be honoured, and the only
  case left to handle is the easy one — `cancel_unpaid_sale()` puts them
  straight back, recorded as `sale_cancelled` so reports can tell it from
  a customer return.

  Each shop connects its **own** Paystack account, so Busihub never holds
  anyone's money. That shop's secret key is stored only as ciphertext
  encrypted in the application, under a key that lives in the server's
  environment and never in the database, and the ciphertext column is not
  selectable by `authenticated` at all — the revoke-then-grant-per-column
  pattern from 0018, applied to the one value in this schema that can move
  real money.

  `settle_sale_payment()` is granted to `service_role` alone: settling is
  something our server does on a verified webhook, never something a
  browser asks for. It is idempotent because Paystack retries a webhook
  for 72 hours until it gets a 200, so the same event arriving twice is
  the normal case, not the edge. `tests/security/payments.sql` covers 32
  assertions — **172 across eight suites** — and three of its guarantees
  were deliberately sabotaged to confirm it fails when they break.

- 2026-08-30 — Phase 12 complete (brought forward ahead of payments):
  refunds and voids. A sale is never edited — a correction is its own
  row. `void_sale()` cancels a whole sale rung up in error, putting the
  stock back and reversing an on-account charge; `create_refund()` takes
  specific lines back, cumulatively capped at what was sold and never
  exceeding it across repeated returns. Money is apportioned from the
  original sale line, not recomputed from today's prices, so a customer
  is refunded what they actually paid even if the shelf price has since
  changed — and, as at the till, no amount crosses the wire for a caller
  to forge. Damaged goods refund without returning to the shelf
  (`restocked = false`). Voiding disappears from the UI once anything has
  been returned, because the database refuses it. Both functions take an
  advisory lock rather than `SELECT ... FOR UPDATE`: locking a `sales`
  row runs it through that table's UPDATE policy, which would have
  demanded `sales.void` of a refund. `tests/security/refunds.sql` covers
  23 assertions, including the permission split between `sales.void`,
  `sales.refund` and `sales.process` on the inventory ledger, and the
  case that separates "nothing was selected" from "the thing being
  returned was free" — a promotional line refunds no money but still has
  to come back onto the shelf, so the empty-return guard counts lines
  rather than testing the total.

- 2026-08-30 — Phase 9 complete: the till. `/till` is a cart with barcode
  or name search (a scanner is a keyboard, so Enter on an exact
  barcode/SKU adds the item — that is the whole of scanner support),
  cash or on-account checkout, and a completed-sale view at `/sales/[id]`.
  Who is serving comes from a PIN, held in an HMAC-signed httpOnly cookie
  (lib/auth/till-session.ts) rather than a plain one: the Supabase session
  still authorises everything, but an unsigned cookie would let a cashier
  attribute a sale to a colleague. Nothing about money crosses the wire —
  the checkout schema carries only variant ids and quantities, so there is
  nothing for a caller to forge; the cart's total is a preview and the
  receipt is what create_sale() computed.

- 2026-08-30 — Migration 0020: sales. One sale writes the sale record, the
  stock ledger and (on account) the customer ledger in one transaction.
  Two properties the file exists to guarantee: money is computed in the
  database from catalog prices and the business's own tax rates —
  create_sale() takes only variant ids and quantities, so a caller cannot
  post its own totals — and stock leaves through inventory_movements
  rather than by touching stock_levels, so the level always reconciles to
  its history. Ghana tax follows the levies-then-VAT order, and for
  tax-inclusive pricing (the default) the components are extracted from
  the shelf price with the tax taken as (gross − subtotal), so the parts
  always sum to the marked price with no stray pesewa. Overselling now
  reads business_settings.pos_settings.allow_negative_stock instead of
  being hardcoded — still blocked by default, but the Settings toggle that
  already existed is no longer a lie; both branches are tested.
  25 assertions in tests/security/sales.sql, 118 across six suites.
  Notable: create_sale originally inserted the sale then UPDATEd it with
  the totals, which the tests caught immediately — `sales` grants no
  UPDATE to anyone, deliberately, and the function runs as the caller so
  RLS applies. Restructured to compute everything first and insert the row
  once, already correct and immutable from birth.
- 2026-08-30 — inventory.sql and customers.sql each dropped an assertion
  that 'sale' movements/entries were rejected "before the sales phase
  exists". They were correct for phases 6–8 and became obsolete when 0020
  arrived; both failed loudly rather than silently, which is what a
  reserved-value test should do. The replacement rule (admitted with
  sales.process, refused without) is asserted in sales.sql.

- 2026-08-30 — Migration 0019 fixes a bug 0018 shipped to production: both
  PIN functions pinned `set search_path = public, pg_temp` (the correct
  habit for SECURITY DEFINER) but Supabase installs pgcrypto into an
  `extensions` schema, so `gen_salt`/`crypt` were not on the path and
  setting a PIN failed with "function gen_salt(unknown, integer) does not
  exist". Caught in the browser within seconds of the feature being tried;
  invisible to typecheck, lint, unit tests, the build, and all five
  database suites.
  The root cause was the harness, not the migration: it did a plain
  `create extension pgcrypto`, which lands in `public`, so every local
  test ran against a database more forgiving than the real one.
  tests/db-harness/00_stub_supabase.sql now installs extensions into an
  `extensions` schema and sets the database search_path to match Supabase,
  which reproduces the production failure locally — confirmed by watching
  the old function fail there before 0019 made it pass. Any future
  search_path mistake of this shape now fails in CI instead of in
  production.

- 2026-08-30 — Migration 0018: two real PIN vulnerabilities closed, found
  while building the till login Phase 2 deferred here — both by querying a
  live database as a Cashier, not by reading the schema.
  (1) Any colleague could SELECT another profile's `pin_hash`. RLS scopes
  profiles by business, but column privileges are a separate mechanism and
  0009 granted table-level SELECT, so the hash was fetchable from
  PostgREST in the browser; bcrypt at cost 10 does not protect a 4–6 digit
  keyspace offline, making this a direct route to whoever authorises
  discounts, voids and refunds. Note that a bare `revoke select (pin_hash)`
  silently does nothing while a table-level grant exists — the fix is
  revoke-then-grant-per-column.
  (2) A user could reset their own `pin_failed_attempts`/`pin_locked_until`,
  so the lockout was bypassable by exactly the person it exists to stop
  (confirmed: the UPDATE reported success and set attempts to 99). 0009's
  escalation guard now covers the PIN columns too.
  Consequence: the hash never leaves the database — `set_profile_pin()`
  and `verify_profile_pin()` hash and compare with pgcrypto inside
  SECURITY DEFINER functions, which also lets a failed attempt increment
  the counter atomically with the check rather than in a round trip a
  caller could skip. 13 assertions in tests/security/pin.sql, demonstrated
  failing against the pre-0018 schema. Wired into CI.

- 2026-08-30 — Phase 8 (customers & credit accounts) complete. Migration
  0017 adds `customers`, an append-only `customer_account_entries` ledger
  and a trigger-maintained `customer_balances`, applying the same
  never-edit-the-number rule as stock. Buying on credit and settling later
  is ordinary in this market, so a contact list without balances would
  have been half a feature. Sign convention fixed once in the schema:
  positive = owes more. `credit_limit` is enforced by the balance trigger
  rather than merely displayed (0, the default, means cash only), and
  `normalize_phone()` folds the ways one Ghanaian mobile number is written
  onto a single key so "one record per phone" actually holds — 024 412
  3456, 0244123456 and +233244123456 all collide. Verified against
  Postgres: `tests/security/customers.sql`, 29 assertions. Wired into CI.
- 2026-08-30 — Corrected a wrong assumption in the test suites: an
  RLS-denied UPDATE does not raise, it matches zero rows silently (only a
  failing WITH CHECK on an INSERT raises 42501). A test asserting "an
  exception was thrown" therefore failed against correct code — and, worse,
  the inverse assertion would have proven nothing. Those checks now assert
  that the data did not move. Separately, both ledger suites gained a test
  for the insert path the Server Actions actually use: they omit
  `business_id` entirely and rely on the BEFORE trigger, where every
  existing test had passed a placeholder.

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