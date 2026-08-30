# Busihub -- apply-sales-schema.ps1
# Phase 9 part 2: the sales schema and create_sale().
$ErrorActionPreference = 'Stop'

Write-Host "Writing .github/workflows/ci.yml"
New-Item -ItemType Directory -Force -Path ".github/workflows" | Out-Null
$content = @'
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  database:
    name: Database migrations & security tests
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: busihub_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      PGPASSWORD: postgres
      PGHOST: localhost
      PGUSER: postgres
      PGDATABASE: busihub_test
    steps:
      - uses: actions/checkout@v4

      - name: Apply auth/role stub (approximates Supabase on plain Postgres)
        run: psql -v ON_ERROR_STOP=1 -f tests/db-harness/00_stub_supabase.sql

      - name: Apply migrations in order
        run: |
          for f in supabase/migrations/*.sql; do
            echo "Applying $f"
            psql -v ON_ERROR_STOP=1 -f "$f"
          done

      - name: Load dev seed data (fixture for the tests below)
        run: psql -v ON_ERROR_STOP=1 -f supabase/seed.sql

      - name: Run tenant isolation & RBAC security tests
        run: psql -v ON_ERROR_STOP=1 -f tests/security/tenant_isolation_and_rbac.sql

      - name: Run inventory ledger & permission tests
        run: psql -v ON_ERROR_STOP=1 -f tests/security/inventory.sql

      - name: Run purchasing (supplier/PO) tests
        run: psql -v ON_ERROR_STOP=1 -f tests/security/purchasing.sql

      - name: Run customer account/credit tests
        run: psql -v ON_ERROR_STOP=1 -f tests/security/customers.sql

      - name: Run cashier PIN security tests
        run: psql -v ON_ERROR_STOP=1 -f tests/security/pin.sql

      - name: Run sales (till) tests
        run: psql -v ON_ERROR_STOP=1 -f tests/security/sales.sql

  app:
    name: Typecheck, lint, build
    runs-on: ubuntu-latest
    env:
      # Build-time placeholders only — no real secret is needed to
      # typecheck/lint/build; a real project is required at deploy time
      # (see docs/DEPLOYMENT.md) via Vercel's environment variables.
      NEXT_PUBLIC_SUPABASE_URL: https://placeholder.supabase.co
      NEXT_PUBLIC_SUPABASE_ANON_KEY: placeholder-anon-key
      SUPABASE_SERVICE_ROLE_KEY: placeholder-service-role-key
      PIN_SESSION_SECRET: placeholder-secret-placeholder-secret-placeholder
      NEXT_PUBLIC_APP_URL: http://localhost:3000
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Unit & integration tests
        run: npm test

      - name: Build
        run: npm run build

  deploy-migrations:
    name: Apply migrations to the real Supabase project
    runs-on: ubuntu-latest
    needs: [database, app]
    # Only ever runs on main, and only if the secret is configured — a
    # fork or a PR from an untrusted branch never gets DB credentials.
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    steps:
      - uses: actions/checkout@v4

      - name: Check SUPABASE_DB_URL is configured
        id: check
        run: |
          if [ -n "${{ secrets.SUPABASE_DB_URL }}" ]; then
            echo "configured=true" >> "$GITHUB_OUTPUT"
          else
            echo "configured=false" >> "$GITHUB_OUTPUT"
            echo "::warning::SUPABASE_DB_URL secret is not set — skipping migration deploy. Add it in Settings → Secrets and variables → Actions to enable this step."
          fi

      - name: Install dependencies
        if: steps.check.outputs.configured == 'true'
        run: npm ci

      - name: Apply migrations to Supabase
        if: steps.check.outputs.configured == 'true'
        env:
          SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}
        run: npm run db:migrate

'@
Set-Content -LiteralPath ".github/workflows/ci.yml" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing docs/ARCHITECTURE.md"
New-Item -ItemType Directory -Force -Path "docs" | Out-Null
$content = @'
# Busihub — Architecture

Status: **Phases 0–8 complete (see the roadmap below).** This document is
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
| 9 | POS core (cash + credit, PIN till login) | **schema done & verified (tests/security/sales.sql); till UI in progress** |
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

'@
Set-Content -LiteralPath "docs/ARCHITECTURE.md" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing supabase/migrations/0020_sales.sql"
New-Item -ItemType Directory -Force -Path "supabase/migrations" | Out-Null
$content = @'
-- Busihub — 0020: sales (Phase 9, the till)
--
-- One sale writes to three ledgers in a single transaction: the sale
-- record itself, the stock ledger (0015), and — when it goes on account —
-- the customer ledger (0017). Either all of it lands or none of it does.
--
-- Agreed scope: cash and credit, overselling BLOCKED, the cashier
-- identified by PIN (0018/0019).
--
-- Two properties this file exists to guarantee:
--
--   * MONEY IS COMPUTED HERE, NOT SENT. create_sale() takes only variant
--     ids and quantities. Every price comes from product_variants and
--     every rate from business_settings, read inside the transaction. A
--     caller cannot post its own totals — the browser's cart figures are
--     a preview, and the receipt shows what the database calculated. This
--     is the difference between a till and a suggestion box.
--
--   * STOCK MOVES THROUGH THE LEDGER. A sale does not touch stock_levels;
--     it writes inventory_movements rows exactly as manual receiving does,
--     so "why is there 7 of these?" stays answerable and the level always
--     reconciles to its history.
--
-- Permissions:
--   sales.process — ring up a sale. Also what admits the 'sale' movement
--                   reason and the 'sale' account entry type, both of
--                   which 0015/0017 reserved for exactly this phase.
--   customers.view — needed to attach a customer (the RLS on customers
--                   already enforces it; noted here so the pairing is
--                   deliberate rather than incidental).

-- ── overselling honours the business's own setting ───────────────────────
--
-- 0015 refused any movement that drove stock negative, full stop. That is
-- the right default and stays the default — business_settings.pos_settings
-- .allow_negative_stock is false out of the box — but the setting already
-- existed (0002) and the Settings screen already exposes it, so enforcing
-- a hardcoded rule instead of reading it would have made that toggle a
-- lie. A shop whose recorded stock it cannot trust can now choose to let
-- the sale through rather than turn a customer away at the counter.
--
-- Phase 17 (offline sync) will need the same escape hatch for a different
-- reason: a sale that already happened in the shop cannot be refused
-- retroactively, so synced sales are specified to land and be flagged.
create or replace function apply_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_new_quantity numeric(14, 3);
  v_allow_negative boolean;
begin
  insert into stock_levels (business_id, branch_id, variant_id, quantity, updated_at)
  values (new.business_id, new.branch_id, new.variant_id, new.quantity_delta, now())
  on conflict (branch_id, variant_id) do update
    set quantity   = stock_levels.quantity + excluded.quantity,
        updated_at = now()
  returning quantity into v_new_quantity;

  if v_new_quantity < 0 then
    select coalesce((pos_settings ->> 'allow_negative_stock')::boolean, false)
    into v_allow_negative
    from business_settings
    where business_id = new.business_id;

    if not coalesce(v_allow_negative, false) then
      raise exception 'Not enough stock: this would leave % on hand', v_new_quantity
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

comment on function apply_inventory_movement() is
  'AFTER INSERT on inventory_movements: applies the delta to stock_levels in the same transaction, refusing to go negative unless the business has opted into allow_negative_stock. SECURITY DEFINER because stock_levels grants users no write access.';

-- ── the 'sale' reason and entry type become insertable ───────────────────
-- 0015 and 0017 deliberately admitted no policy for these, so that they
-- were rejected until the phase that generates them existed. It does now.

create policy inventory_movements_insert_sale on inventory_movements
  for insert
  with check (
    reason in ('sale', 'sale_refund')
    and app_has_permission(business_id, 'sales.process')
  );

create policy customer_account_entries_insert_sale on customer_account_entries
  for insert
  with check (
    entry_type = 'sale'
    and app_has_permission(business_id, 'customers.view')
    and app_has_permission(business_id, 'sales.process')
  );

-- ── sales ────────────────────────────────────────────────────────────────

create table sales (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  branch_id       uuid not null references branches(id) on delete restrict,
  receipt_number  text not null check (char_length(trim(receipt_number)) > 0),
  -- Null for a walk-in. Required for a credit sale (checked in create_sale).
  customer_id     uuid references customers(id) on delete restrict,
  status          text not null default 'completed'
                    check (status in ('completed', 'voided')),
  payment_method  text not null check (payment_method in ('cash', 'credit')),
  -- All numeric(14,2). subtotal excludes tax; total = subtotal + tax_total.
  subtotal        numeric(14, 2) not null check (subtotal >= 0),
  tax_total       numeric(14, 2) not null check (tax_total >= 0),
  total           numeric(14, 2) not null check (total >= 0),
  amount_tendered numeric(14, 2) not null default 0 check (amount_tendered >= 0),
  change_given    numeric(14, 2) not null default 0 check (change_given >= 0),
  -- Who was at the counter (PIN-identified), and which account the device
  -- was signed in as. Usually different people on a shared till, which is
  -- the entire point of the PIN.
  cashier_id      uuid references profiles(id) on delete set null,
  created_by      uuid references profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (business_id, receipt_number)
);

create index sales_business_created_idx on sales (business_id, created_at desc);
create index sales_branch_created_idx on sales (branch_id, created_at desc);
create index sales_customer_idx on sales (customer_id);

comment on table sales is
  'A completed sale. Financial record: never updated or deleted — a correction is a refund or a void, which get their own rows in a later phase (Section: Money integrity).';

create table sale_items (
  id            uuid primary key default gen_random_uuid(),
  sale_id       uuid not null references sales(id) on delete cascade,
  business_id   uuid not null references businesses(id) on delete cascade,
  variant_id    uuid not null references product_variants(id) on delete restrict,
  -- Snapshots. The catalog will change; a receipt from last year must
  -- still say what was actually sold and at what price.
  description   text not null,
  sku           text,
  quantity      numeric(14, 3) not null check (quantity > 0),
  unit_price    numeric(14, 2) not null check (unit_price >= 0),
  tax_category  text not null,
  line_subtotal numeric(14, 2) not null check (line_subtotal >= 0),
  line_tax      numeric(14, 2) not null check (line_tax >= 0),
  line_total    numeric(14, 2) not null check (line_total >= 0),
  created_at    timestamptz not null default now()
);

create index sale_items_sale_idx on sale_items (sale_id);
create index sale_items_variant_idx on sale_items (variant_id);

comment on table sale_items is
  'One line of a sale, with the description, SKU and price snapshotted at the moment of sale rather than joined from the catalog later.';

-- ── RLS: readable by those who can see sales; never mutable ──────────────

alter table sales enable row level security;

create policy sales_select on sales
  for select
  using (
    app_has_permission(business_id, 'sales.process')
    or app_has_permission(business_id, 'reports.view')
    or app_is_super_admin()
  );

create policy sales_insert on sales
  for insert
  with check (app_has_permission(business_id, 'sales.process') or app_is_super_admin());

-- No update and no delete policy, and the grants withdrawn: a completed
-- sale is a financial record. Voids and refunds are new rows in a later
-- phase, not edits to this one.
revoke update, delete on sales from authenticated;

alter table sale_items enable row level security;

create policy sale_items_select on sale_items
  for select
  using (
    app_has_permission(business_id, 'sales.process')
    or app_has_permission(business_id, 'reports.view')
    or app_is_super_admin()
  );

create policy sale_items_insert on sale_items
  for insert
  with check (app_has_permission(business_id, 'sales.process') or app_is_super_admin());

revoke update, delete on sale_items from authenticated;

-- ── create_sale(): the whole transaction ─────────────────────────────────
--
-- Takes what the till knows (branch, cashier, customer, payment, and a
-- list of variant ids + quantities) and derives everything else.
--
-- SECURITY INVOKER, like create_product and create_purchase_order: it runs
-- as the caller, so every RLS policy above and in 0015/0017 applies to its
-- writes exactly as if the caller had made them. That is also what stops
-- p_branch_id being pointed at another tenant.
--
-- Tax follows docs/ARCHITECTURE and lib/money/money.ts's calculateGhanaTax:
-- NHIL/GETFund/COVID levies apply to the taxable value, then VAT applies to
-- (value + levies). When the business prices tax-INCLUSIVE (the default),
-- the shelf price already contains all of that and the components are
-- extracted back out of it:
--     price = base * (1 + levyRates) * (1 + vatRate)
-- so base = price / ((1 + levyRates) * (1 + vatRate)).
create or replace function create_sale(
  p_branch_id uuid,
  p_cashier_id uuid,
  p_customer_id uuid,
  p_payment_method text,
  p_amount_tendered numeric,
  p_items jsonb -- [{variant_id, quantity}]
)
returns uuid
language plpgsql
as $$
declare
  v_business_id   uuid;
  v_sale_id       uuid;
  v_item          jsonb;
  v_variant       record;
  v_qty           numeric(14, 3);
  v_next          int;
  v_reference     text;
  v_settings      jsonb;
  v_vat_enabled   boolean;
  v_inclusive     boolean;
  v_vat           numeric;
  v_levies        numeric;
  v_gross         numeric(14, 2);
  v_base          numeric;
  v_line_tax      numeric(14, 2);
  v_line_subtotal numeric(14, 2);
  v_subtotal      numeric(14, 2) := 0;
  v_tax_total     numeric(14, 2) := 0;
  v_total         numeric(14, 2) := 0;
  v_change        numeric(14, 2) := 0;
  -- Priced lines from the first pass, so the second can write them
  -- without recomputing (and without the two passes ever disagreeing).
  v_lines         jsonb := '[]'::jsonb;
begin
  if p_items is null or jsonb_array_length(p_items) < 1 then
    raise exception 'A sale needs at least one item' using errcode = 'P0001';
  end if;

  if p_payment_method not in ('cash', 'credit') then
    raise exception 'Unknown payment method' using errcode = '22023';
  end if;

  select business_id into v_business_id from branches where id = p_branch_id;
  if v_business_id is null then
    raise exception 'Invalid branch_id: branch not found' using errcode = 'P0002';
  end if;

  if p_payment_method = 'credit' and p_customer_id is null then
    raise exception 'A credit sale needs a customer' using errcode = 'P0001';
  end if;

  if p_customer_id is not null then
    if not exists (select 1 from customers where id = p_customer_id and business_id = v_business_id) then
      raise exception 'Invalid customer_id: customer not found' using errcode = 'P0002';
    end if;
  end if;

  if p_cashier_id is not null then
    if not exists (
      select 1 from profiles
      where id = p_cashier_id and business_id = v_business_id and status = 'active'
    ) then
      raise exception 'Invalid cashier' using errcode = 'P0002';
    end if;
  end if;

  select tax_settings into v_settings from business_settings where business_id = v_business_id;
  v_vat_enabled := coalesce((v_settings ->> 'vat_enabled')::boolean, false);
  v_inclusive   := coalesce((v_settings ->> 'vat_inclusive')::boolean, true);
  v_vat         := coalesce((v_settings ->> 'vat_rate')::numeric, 0);
  v_levies      := coalesce((v_settings ->> 'nhil_levy_rate')::numeric, 0)
                 + coalesce((v_settings ->> 'getfund_levy_rate')::numeric, 0)
                 + coalesce((v_settings ->> 'covid_levy_rate')::numeric, 0);

  -- FIRST PASS: price every line and total the sale, writing nothing.
  --
  -- The sale row is inserted once, already correct, rather than inserted
  -- blank and UPDATEd with the totals afterwards. That is not a style
  -- preference: `sales` deliberately grants no UPDATE to anyone (a
  -- completed sale is a financial record), so a function that runs as the
  -- caller — which this one does, so that RLS applies to its writes —
  -- cannot update it. Found by the tests, which is what they are for.
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every line needs a quantity greater than zero' using errcode = 'P0001';
    end if;

    -- The price comes from here, never from the caller.
    select v.id, v.sku, v.selling_price, v.status, p.name, p.tax_category
    into v_variant
    from product_variants v
    join products p on p.id = v.product_id
    where v.id = (v_item ->> 'variant_id')::uuid
      and v.business_id = v_business_id;

    if v_variant.id is null then
      raise exception 'Invalid variant_id: product not found' using errcode = 'P0002';
    end if;
    if v_variant.status <> 'active' then
      raise exception 'That product is archived and cannot be sold' using errcode = 'P0001';
    end if;

    v_gross := round(v_variant.selling_price * v_qty, 2);

    if not v_vat_enabled or v_variant.tax_category in ('zero_rated', 'exempt') then
      v_line_tax := 0;
      v_line_subtotal := v_gross;
    elsif v_inclusive then
      -- Extract the tax already contained in the shelf price. The tax is
      -- taken as (gross - subtotal) rather than rounded separately, so the
      -- parts always sum to the price on the shelf with no stray pesewa.
      v_base := v_gross / ((1 + v_levies) * (1 + v_vat));
      v_line_subtotal := round(v_base, 2);
      v_line_tax := v_gross - v_line_subtotal;
    else
      -- Add tax on top of the shelf price.
      v_line_subtotal := v_gross;
      v_line_tax := round((v_gross * v_levies) + ((v_gross * (1 + v_levies)) * v_vat), 2);
      v_gross := v_line_subtotal + v_line_tax;
    end if;

    v_lines := v_lines || jsonb_build_object(
      'variant_id', v_variant.id,
      'description', v_variant.name,
      'sku', v_variant.sku,
      'quantity', v_qty,
      'unit_price', v_variant.selling_price,
      'tax_category', v_variant.tax_category,
      'line_subtotal', v_line_subtotal,
      'line_tax', v_line_tax,
      'line_total', v_gross
    );

    v_subtotal  := v_subtotal + v_line_subtotal;
    v_tax_total := v_tax_total + v_line_tax;
    v_total     := v_total + v_gross;
  end loop;

  if p_payment_method = 'cash' then
    if coalesce(p_amount_tendered, 0) < v_total then
      raise exception 'Not enough cash tendered for a total of %', v_total using errcode = 'P0001';
    end if;
    v_change := coalesce(p_amount_tendered, 0) - v_total;
  end if;

  -- Receipt number, serialised per business so two tills cannot both
  -- claim R-000042 (the unique constraint would catch it, but as a failed
  -- sale rather than as two correct numbers). Same approach as PO
  -- references in 0016.
  perform pg_advisory_xact_lock(hashtextextended('receipt:' || v_business_id::text, 0));

  select coalesce(max((substring(receipt_number from '^R-([0-9]+)$'))::int), 0) + 1
  into v_next
  from sales
  where business_id = v_business_id and receipt_number ~ '^R-[0-9]+$';

  v_reference := 'R-' || lpad(v_next::text, 6, '0');

  insert into sales (
    business_id, branch_id, receipt_number, customer_id, payment_method,
    subtotal, tax_total, total, amount_tendered, change_given, cashier_id, created_by
  )
  values (
    v_business_id, p_branch_id, v_reference, p_customer_id, p_payment_method,
    v_subtotal, v_tax_total, v_total, coalesce(p_amount_tendered, 0), v_change,
    p_cashier_id, auth.uid()
  )
  returning id into v_sale_id;

  -- SECOND PASS: the lines, and the stock they take out.
  for v_item in select * from jsonb_array_elements(v_lines)
  loop
    insert into sale_items (
      sale_id, business_id, variant_id, description, sku, quantity,
      unit_price, tax_category, line_subtotal, line_tax, line_total
    )
    values (
      v_sale_id, v_business_id, (v_item ->> 'variant_id')::uuid,
      v_item ->> 'description', v_item ->> 'sku', (v_item ->> 'quantity')::numeric,
      (v_item ->> 'unit_price')::numeric, v_item ->> 'tax_category',
      (v_item ->> 'line_subtotal')::numeric, (v_item ->> 'line_tax')::numeric,
      (v_item ->> 'line_total')::numeric
    );

    -- Stock leaves through the ledger, not by touching the level. The
    -- 0015 trigger refuses to go negative unless the business allows it.
    insert into inventory_movements (
      business_id, branch_id, variant_id, quantity_delta, reason,
      reference_type, reference_id, note
    )
    values (
      '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
      p_branch_id, (v_item ->> 'variant_id')::uuid, -(v_item ->> 'quantity')::numeric, 'sale',
      'sale', v_sale_id, 'Sold on ' || v_reference
    );
  end loop;

  -- On account: the balance moves through the customer ledger, and 0017's
  -- credit-limit check applies — so a sale that would take them over their
  -- limit is refused here, rolling the whole thing back.
  if p_payment_method = 'credit' then
    insert into customer_account_entries (
      business_id, customer_id, branch_id, amount, entry_type, reference_type, reference_id, note
    )
    values (
      '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
      p_customer_id, p_branch_id, v_total, 'sale', 'sale', v_sale_id,
      'Sale ' || v_reference
    );
  end if;

  return v_sale_id;
end;
$$;

grant execute on function create_sale(uuid, uuid, uuid, text, numeric, jsonb) to authenticated;

comment on function create_sale(uuid, uuid, uuid, text, numeric, jsonb) is
  'Rings up a sale in one transaction: the sale and its lines, the stock movements that take the goods out, and (on credit) the customer account entry. Prices and tax rates are read from the database, never accepted from the caller.';

-- A completed sale must not be silently editable even by a statement that
-- reaches the table directly. The revokes above stop UPDATE/DELETE; this
-- makes the intent explicit for anyone reading the schema.
comment on column sales.status is
  'completed or voided. Voiding is a later phase and will be a function, not an UPDATE — there is deliberately no update policy or grant on this table.';

'@
Set-Content -LiteralPath "supabase/migrations/0020_sales.sql" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing tests/security/customers.sql"
New-Item -ItemType Directory -Force -Path "tests/security" | Out-Null
$content = @'
-- Busihub — security/behaviour test for customers & credit accounts
-- (migration 0017), exercised directly against Postgres + RLS rather than
-- through the application.
--
-- Run against a throwaway Postgres loaded with
-- tests/db-harness/00_stub_supabase.sql + supabase/migrations/*.sql +
-- supabase/seed.sql (see tests/security/README.md).
--
-- Every `TEST FAILED` raise carries SQLSTATE ZZ999, which no handler in
-- this file catches. That matters: the default for `raise exception` is
-- P0001, which several blocks below catch as the *expected* rejection —
-- so a wrongly-succeeding operation would otherwise have its own failure
-- message swallowed and printed as a PASS.

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000044',
   'authenticated', 'authenticated', 'ownerd@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000097',
   'authenticated', 'authenticated', 'auditor@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000044';
select register_business('Customer Test Shop D', 'Esi', 'Mensah');
reset role;
reset request.jwt.claim.sub;

create table c_ids as
select
  (select id from businesses where slug = 'busihub-demo-store')      as biz_a,
  (select id from businesses where slug = 'customer-test-shop-d')    as biz_d,
  (select b.id from branches b
     where b.business_id = (select id from businesses where slug = 'busihub-demo-store')
       and b.is_main)                                                as branch_a,
  (select b.id from branches b
     where b.business_id = (select id from businesses where slug = 'customer-test-shop-d')
       and b.is_main)                                                as branch_d;

do $$
declare r record;
begin
  select * into r from c_ids;
  if r.biz_a is null or r.biz_d is null or r.branch_a is null or r.branch_d is null then
    raise exception 'TEST FIXTURE BROKEN: c_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

grant select on c_ids to authenticated;

-- An Auditor on business A: customers.view but NOT customers.edit.
do $$
declare v_biz uuid; v_branch uuid; v_role uuid;
begin
  select biz_a, branch_a into v_biz, v_branch from c_ids;
  select id into v_role from roles where business_id = v_biz and name = 'Auditor';

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000097', v_biz, 'Read', 'Only', 'auditor@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000000097', v_role,
            '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;

  -- Guard the fixture: if Auditor ever gains customers.edit, test 9 would
  -- "pass" for entirely the wrong reason.
  if exists (
    select 1 from role_permissions rp join permissions p on p.id = rp.permission_id
    where rp.role_id = v_role and p.key = 'customers.edit'
  ) then
    raise exception 'TEST FIXTURE BROKEN: Auditor unexpectedly holds customers.edit' using errcode = 'ZZ999';
  end if;
end $$;

-- ── 1. Phone uniqueness survives reformatting ────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_a uuid; v_key text;
begin
  insert into customers (business_id, name, phone, credit_limit)
  select biz_a, 'Ama Owusu', '024 412 3456', 500 from c_ids returning id into v_a;

  select phone_key into v_key from customers where id = v_a;
  if v_key <> '0244123456' then
    raise exception 'TEST FAILED: phone_key should be 0244123456, got %', v_key using errcode = 'ZZ999';
  end if;

  -- The same number written three other ways must all collide.
  begin
    insert into customers (business_id, name, phone) select biz_a, 'Ama Again', '+233244123456' from c_ids;
    raise exception 'TEST FAILED: +233 form did not collide with the local form' using errcode = 'ZZ999';
  exception when unique_violation then
    raise notice 'PASS: +233244123456 collides with 024 412 3456';
  end;

  begin
    insert into customers (business_id, name, phone) select biz_a, 'Ama Again', '0244123456' from c_ids;
    raise exception 'TEST FAILED: unformatted form did not collide' using errcode = 'ZZ999';
  exception when unique_violation then
    raise notice 'PASS: 0244123456 collides too';
  end;

  -- A customer with no phone at all is fine, and several of them coexist.
  insert into customers (business_id, name) select biz_a, 'Walk-in One' from c_ids;
  insert into customers (business_id, name) select biz_a, 'Walk-in Two' from c_ids;
  raise notice 'PASS: multiple customers with no phone coexist';
end $$;

-- ── 2. Credit limit is enforced, not decorative ──────────────────────────

do $$
declare v_c uuid; v_balance numeric;
begin
  select id into v_c from customers where name = 'Ama Owusu';

  -- Within the 500 limit.
  insert into customer_account_entries (business_id, customer_id, amount, entry_type, note)
  values ('00000000-0000-0000-0000-000000000000', v_c, 200, 'charge', 'bag of rice');

  select balance into v_balance from customer_balances where customer_id = v_c;
  if v_balance <> 200 then
    raise exception 'TEST FAILED: expected balance 200, got %', v_balance using errcode = 'ZZ999';
  end if;

  -- Taking it to exactly the limit is allowed.
  insert into customer_account_entries (business_id, customer_id, amount, entry_type)
  values ('00000000-0000-0000-0000-000000000000', v_c, 300, 'charge');

  select balance into v_balance from customer_balances where customer_id = v_c;
  if v_balance <> 500 then
    raise exception 'TEST FAILED: expected balance 500 at the limit, got %', v_balance using errcode = 'ZZ999';
  end if;

  -- One pesewa over is not.
  begin
    insert into customer_account_entries (business_id, customer_id, amount, entry_type)
    values ('00000000-0000-0000-0000-000000000000', v_c, 0.01, 'charge');
    raise exception 'TEST FAILED: a charge exceeding the credit limit was accepted' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: charge over the credit limit rejected (%)', sqlerrm;
  end;

  select balance into v_balance from customer_balances where customer_id = v_c;
  if v_balance <> 500 then
    raise exception 'TEST FAILED: rejected charge still moved the balance to %', v_balance using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: rejected charge left the balance at 500';
end $$;

-- ── 3. The default limit of zero means cash only ─────────────────────────

do $$
declare v_c uuid; v_exists boolean;
begin
  select id into v_c from customers where name = 'Walk-in One';

  begin
    insert into customer_account_entries (business_id, customer_id, amount, entry_type)
    values ('00000000-0000-0000-0000-000000000000', v_c, 1, 'charge');
    raise exception 'TEST FAILED: a customer with no credit limit was charged on credit' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: default credit limit of 0 blocks credit entirely';
  end;

  select exists(select 1 from customer_balances where customer_id = v_c and balance <> 0) into v_exists;
  if v_exists then
    raise exception 'TEST FAILED: rejected charge left a non-zero balance behind' using errcode = 'ZZ999';
  end if;
end $$;

-- ── 4. Payments, including overpayment ───────────────────────────────────

do $$
declare v_c uuid; v_balance numeric; v_entry uuid; v_amount numeric;
begin
  select id into v_c from customers where name = 'Ama Owusu';

  select record_customer_payment(v_c, 200, (select branch_a from c_ids), 'part payment') into v_entry;

  select amount into v_amount from customer_account_entries where id = v_entry;
  if v_amount <> -200 then
    raise exception 'TEST FAILED: a payment of 200 should store as -200, got %', v_amount using errcode = 'ZZ999';
  end if;

  select balance into v_balance from customer_balances where customer_id = v_c;
  if v_balance <> 300 then
    raise exception 'TEST FAILED: expected 300 owing after paying 200 of 500, got %', v_balance using errcode = 'ZZ999';
  end if;

  -- Paying more than owed is legitimate — the customer is then in credit.
  perform record_customer_payment(v_c, 400, null, 'overpaid');
  select balance into v_balance from customer_balances where customer_id = v_c;
  if v_balance <> -100 then
    raise exception 'TEST FAILED: expected -100 (in credit), got %', v_balance using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: payments reduce the balance and overpayment leaves the customer in credit (-100)';

  -- A customer in credit can be charged again without touching the limit.
  insert into customer_account_entries (business_id, customer_id, amount, entry_type)
  values ('00000000-0000-0000-0000-000000000000', v_c, 100, 'charge');
  select balance into v_balance from customer_balances where customer_id = v_c;
  if v_balance <> 0 then
    raise exception 'TEST FAILED: expected 0 after charging 100 against 100 credit, got %', v_balance using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: charging against existing credit works and lands on 0';
end $$;

-- ── 5. A payment must be a payment ───────────────────────────────────────

do $$
declare v_c uuid;
begin
  select id into v_c from customers where name = 'Ama Owusu';

  begin
    perform record_customer_payment(v_c, 0, null, null);
    raise exception 'TEST FAILED: a zero payment was accepted' using errcode = 'ZZ999';
  exception when sqlstate '22023' then
    raise notice 'PASS: zero payment rejected';
  end;

  begin
    perform record_customer_payment(v_c, -50, null, null);
    raise exception 'TEST FAILED: a negative payment was accepted' using errcode = 'ZZ999';
  exception when sqlstate '22023' then
    raise notice 'PASS: negative payment rejected';
  end;

  begin
    insert into customer_account_entries (business_id, customer_id, amount, entry_type)
    values ('00000000-0000-0000-0000-000000000000', v_c, 0, 'adjustment');
    raise exception 'TEST FAILED: a zero-amount entry was accepted' using errcode = 'ZZ999';
  exception when check_violation then
    raise notice 'PASS: zero-amount entry rejected by the check constraint';
  end;
end $$;

-- ── 6. business_id and created_by are forced, not trusted ────────────────

do $$
declare v_c uuid; v_biz uuid; v_by uuid; v_biz_a uuid; v_biz_d uuid;
begin
  select biz_a, biz_d into v_biz_a, v_biz_d from c_ids;
  select id into v_c from customers where name = 'Ama Owusu';

  insert into customer_account_entries (business_id, customer_id, amount, entry_type, created_by)
  values (v_biz_d, v_c, -10, 'payment', '00000000-0000-0000-0000-000000000097');

  select business_id, created_by into v_biz, v_by
  from customer_account_entries order by created_at desc, id desc limit 1;

  if v_biz <> v_biz_a then
    raise exception 'TEST FAILED: spoofed business_id survived (%)', v_biz using errcode = 'ZZ999';
  end if;
  if v_by <> '00000000-0000-0000-0000-000000000001' then
    raise exception 'TEST FAILED: spoofed created_by survived (%)', v_by using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: business_id and created_by are overwritten from customer/session';
end $$;

-- ── 7. Reserved entry types are not insertable yet ───────────────────────

do $$
declare v_c uuid;
begin
  select id into v_c from customers where name = 'Ama Owusu';

  -- NOTE: 'sale' used to be asserted here as universally rejected. Since
  -- 0020 the sales phase exists and 'sale' is admitted for a caller with
  -- sales.process + customers.view; that rule is covered in
  -- tests/security/sales.sql. 'refund' below is still genuinely reserved.

  begin
    insert into customer_account_entries (business_id, customer_id, amount, entry_type)
    values ('00000000-0000-0000-0000-000000000000', v_c, -10, 'refund');
    raise exception 'TEST FAILED: a "refund" entry was insertable before the refunds phase' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: reserved entry type "refund" rejected by RLS';
  end;
end $$;

-- ── 8. The balance is not directly writable, and the ledger is final ─────

do $$
begin
  begin
    update customer_balances set balance = 0;
    raise exception 'TEST FAILED: customer_balances was directly UPDATEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: direct UPDATE on customer_balances refused (no grant)';
  end;

  begin
    insert into customer_balances (customer_id, business_id, balance)
    select id, business_id, 9999 from customers where name = 'Walk-in Two';
    raise exception 'TEST FAILED: customer_balances was directly INSERTable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: direct INSERT on customer_balances refused (no grant)';
  end;

  begin
    delete from customer_balances;
    raise exception 'TEST FAILED: customer_balances rows were DELETEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: direct DELETE on customer_balances refused (no grant)';
  end;

  begin
    update customer_account_entries set amount = 1;
    raise exception 'TEST FAILED: a ledger entry was UPDATEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: UPDATE on customer_account_entries refused (grant revoked)';
  end;

  begin
    delete from customer_account_entries;
    raise exception 'TEST FAILED: a ledger entry was DELETEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: DELETE on customer_account_entries refused (grant revoked)';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 9. Read-only role can look but not touch ─────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000097';

do $$
declare v_seen int; v_c uuid;
begin
  select count(*) into v_seen from customers;
  if v_seen < 1 then
    raise exception 'TEST FAILED: auditor holds customers.view but saw no customers' using errcode = 'ZZ999';
  end if;

  select count(*) into v_seen from customer_balances;
  if v_seen < 1 then
    raise exception 'TEST FAILED: auditor saw no balances' using errcode = 'ZZ999';
  end if;

  select id into v_c from customers where name = 'Ama Owusu';

  begin
    insert into customer_account_entries (business_id, customer_id, amount, entry_type)
    values ('00000000-0000-0000-0000-000000000000', v_c, 50, 'charge');
    raise exception 'TEST FAILED: auditor recorded a charge without customers.edit' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: auditor blocked from recording a charge';
  end;

  begin
    perform record_customer_payment(v_c, 10, null, null);
    raise exception 'TEST FAILED: auditor recorded a payment without customers.edit' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: auditor blocked from recording a payment';
  end;

  -- An RLS-denied UPDATE does NOT raise: the row simply falls outside the
  -- policy's USING clause, so the statement matches nothing and succeeds
  -- with 0 rows. (An INSERT is different — a failing WITH CHECK raises
  -- 42501, which is why the inserts above assert on an exception.) So the
  -- property to assert here is that the DATA did not move, not that an
  -- error appeared; asserting the latter would fail on correct code, and
  -- an assertion that merely expects "no exception" would prove nothing.
  declare
    v_rows int;
    v_limit_before numeric;
    v_limit_after numeric;
  begin
    select credit_limit into v_limit_before from customers where id = v_c;

    update customers set credit_limit = 99999 where id = v_c;
    get diagnostics v_rows = row_count;

    select credit_limit into v_limit_after from customers where id = v_c;

    if v_rows <> 0 then
      raise exception 'TEST FAILED: auditor''s credit-limit UPDATE touched % row(s)', v_rows using errcode = 'ZZ999';
    end if;
    if v_limit_after is distinct from v_limit_before then
      raise exception 'TEST FAILED: auditor changed a credit limit (% -> %)', v_limit_before, v_limit_after
        using errcode = 'ZZ999';
    end if;

    raise notice 'PASS: auditor cannot change a credit limit (0 rows, limit still %)', v_limit_after;
  end;

  -- Same silent-denial shape for an ordinary field.
  declare v_name_after text;
  begin
    update customers set name = 'Renamed By Auditor' where id = v_c;
    select name into v_name_after from customers where id = v_c;
    if v_name_after <> 'Ama Owusu' then
      raise exception 'TEST FAILED: auditor renamed a customer to %', v_name_after using errcode = 'ZZ999';
    end if;
    raise notice 'PASS: auditor cannot edit customer details either';
  end;

  raise notice 'PASS: read-only role can see customers and balances';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 10. Cross-tenant isolation ───────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000044';

do $$
declare v_seen int; v_c uuid; v_new uuid;
begin
  select count(*) into v_seen from customers;
  if v_seen <> 0 then
    raise exception 'TEST FAILED: business D owner saw % of business A''s customers', v_seen using errcode = 'ZZ999';
  end if;

  select count(*) into v_seen from customer_balances;
  if v_seen <> 0 then
    raise exception 'TEST FAILED: business D owner saw % of business A''s balances', v_seen using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: business D sees none of business A''s customers or balances';

  -- The same phone number in a DIFFERENT business is a different person
  -- and must be allowed — uniqueness is per business, not global.
  insert into customers (business_id, name, phone) select biz_d, 'Different Ama', '0244123456' from c_ids
  returning id into v_new;
  if v_new is null then
    raise exception 'TEST FAILED: could not reuse a phone number in another business' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: the same phone number is reusable in a different business';

  -- Business A's customer is invisible here, so an entry against them
  -- reports "not found" rather than leaking that they exist.
  select id into v_c from customers where name = 'Different Ama';
  begin
    insert into customer_account_entries (business_id, customer_id, branch_id, amount, entry_type)
    select biz_d, v_c, branch_a, 10, 'charge' from c_ids;
    raise exception 'TEST FAILED: attached business A''s branch to a business D entry' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0002' then raise notice 'PASS: foreign branch on an entry rejected (not visible)';
    when sqlstate 'P0001' then raise notice 'PASS: foreign branch on an entry rejected (business mismatch)';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 10b. The path the application actually takes ─────────────────────────
-- Every test above supplies a placeholder business_id, because the column
-- is NOT NULL. The Server Actions do NOT: they omit it entirely and let
-- set_customer_account_entry_context() fill it in. NOT NULL is checked
-- after BEFORE triggers, so this should work — but "should" is why it is
-- worth one test rather than an assumption.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_c uuid; v_id uuid; v_biz uuid; v_biz_a uuid;
begin
  select biz_a into v_biz_a from c_ids;
  select id into v_c from customers where name = 'Ama Owusu';

  -- business_id deliberately absent, exactly as the app inserts it.
  insert into customer_account_entries (customer_id, amount, entry_type, note)
  values (v_c, -25, 'payment', 'omitted business_id')
  returning id into v_id;

  select business_id into v_biz from customer_account_entries where id = v_id;
  if v_biz is distinct from v_biz_a then
    raise exception 'TEST FAILED: omitted business_id resolved to % (expected %)', v_biz, v_biz_a
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: an entry inserted without business_id (as the app does) is filled in correctly';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 11. Balances reconcile to the ledger ─────────────────────────────────

do $$
declare v_mismatches int;
begin
  select count(*) into v_mismatches
  from customer_balances b
  where b.balance is distinct from (
    select coalesce(sum(e.amount), 0)
    from customer_account_entries e
    where e.customer_id = b.customer_id
  );

  if v_mismatches <> 0 then
    raise exception 'TEST FAILED: % balance(s) disagree with their ledger', v_mismatches using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: every customer balance reconciles exactly to its ledger';
end $$;

\echo ''
\echo 'All customer tests passed.'

'@
Set-Content -LiteralPath "tests/security/customers.sql" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing tests/security/inventory.sql"
New-Item -ItemType Directory -Force -Path "tests/security" | Out-Null
$content = @'
-- Busihub — security/behaviour test for inventory (migration 0015),
-- exercised directly against Postgres + RLS rather than through the
-- application, so a bug in a Server Action can never be the reason these
-- guarantees appear to hold.
--
-- Run against a throwaway Postgres loaded with
-- tests/db-harness/00_stub_supabase.sql + supabase/migrations/*.sql +
-- supabase/seed.sql (see tests/security/README.md).
--
-- Any `TEST FAILED` aborts the script (ON_ERROR_STOP); CI treats a
-- non-zero psql exit code as a failed build.

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────
-- Business A + its Owner (001) and Cashier (099) come from seed.sql.
-- Business B exists so cross-tenant attempts have somewhere to point.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000042',
        'authenticated', 'authenticated', 'ownerb@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000042';
select register_business('Inventory Test Shop B', 'Kofi', 'Boateng');
reset role;
reset request.jwt.claim.sub;

-- A product in business A, created by A's owner through the real RPC.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select create_product(
  (select id from businesses where slug = 'busihub-demo-store'),
  'Test Rice 5kg', null, 'Grains', 'each', 'standard',
  '{}'::text[],
  '[{"sku": "RICE-5KG", "barcode": "", "variant_options": {}, "cost_price": 40, "selling_price": 55}]'::jsonb
);
reset role;
reset request.jwt.claim.sub;

-- Handy ids for the rest of the script. A plain table rather than a
-- TEMPORARY one: the blocks below run under `set role authenticated`, and
-- a temp table owned by postgres isn't reachable from another role.
create table t_ids as
select
  -- Pinned by slug, not "whichever business isn't B": this file may run
  -- in the same database as tenant_isolation_and_rbac.sql, which creates
  -- a third business, and a `limit 1` would then be a coin flip.
  (select id from businesses where slug = 'busihub-demo-store')          as biz_a,
  (select id from businesses where slug = 'inventory-test-shop-b')       as biz_b,
  (select b.id from branches b
     where b.business_id = (select id from businesses where slug = 'busihub-demo-store')
       and b.is_main)                                                    as branch_a,
  (select b.id from branches b
     where b.business_id = (select id from businesses where slug = 'inventory-test-shop-b')
       and b.is_main)                                                    as branch_b,
  (select v.id from product_variants v where v.sku = 'RICE-5KG')         as variant_a;

-- Fail loudly if any fixture id came back null, rather than letting the
-- tests below "pass" against nulls.
do $$
declare r record;
begin
  select * into r from t_ids;
  if r.biz_a is null or r.biz_b is null or r.branch_a is null or r.branch_b is null or r.variant_a is null then
    raise exception 'TEST FIXTURE BROKEN: t_ids has a null (biz_a=%, biz_b=%, branch_a=%, branch_b=%, variant_a=%)',
      r.biz_a, r.biz_b, r.branch_a, r.branch_b, r.variant_a using errcode = 'ZZ999';
  end if;
end $$;

grant select on t_ids to authenticated;

-- A Cashier on business A (inventory.view, but neither .receive nor
-- .adjust) — the "can look but not touch" case in test 10. Created here
-- rather than assumed: seed.sql only creates the Owner.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000099',
        'authenticated', 'authenticated', 'cashier@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

do $$
declare
  v_business_id uuid;
  v_branch_id uuid;
  v_cashier_role_id uuid;
begin
  select biz_a, branch_a into v_business_id, v_branch_id from t_ids;
  select id into v_cashier_role_id from roles where business_id = v_business_id and name = 'Cashier';

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000099', v_business_id, 'Demo', 'Cashier', 'cashier@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_business_id, v_branch_id, '00000000-0000-0000-0000-000000000099',
            v_cashier_role_id, '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;

  -- Guard the fixture itself: if the Cashier role ever stops carrying
  -- inventory.view, test 10 would "pass" for the wrong reason.
  if not exists (
    select 1 from role_permissions rp
    join permissions p on p.id = rp.permission_id
    where rp.role_id = v_cashier_role_id and p.key = 'inventory.view'
  ) then
    raise exception 'TEST FIXTURE BROKEN: seeded Cashier role does not hold inventory.view' using errcode = 'ZZ999';
  end if;
end $$;

-- ── 1. Receiving stock accumulates into the derived level ────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_qty numeric; v_branch uuid; v_variant uuid;
begin
  select branch_a, variant_a into v_branch, v_variant from t_ids;

  insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason, note)
  values ('00000000-0000-0000-0000-000000000000', v_branch, v_variant, 10, 'receive', 'first delivery');

  select quantity into v_qty from stock_levels where branch_id = v_branch and variant_id = v_variant;
  if v_qty is distinct from 10 then
    raise exception 'TEST FAILED: expected 10 on hand after receiving 10, got %', v_qty using errcode = 'ZZ999';
  end if;

  insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
  values ('00000000-0000-0000-0000-000000000000', v_branch, v_variant, 5, 'receive');

  select quantity into v_qty from stock_levels where branch_id = v_branch and variant_id = v_variant;
  if v_qty is distinct from 15 then
    raise exception 'TEST FAILED: expected 15 after a second receipt of 5, got %', v_qty using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: receipts accumulate into stock_levels (10 then 15)';
end $$;

-- ── 2. business_id and created_by are forced, not trusted ────────────────

do $$
declare v_biz uuid; v_by uuid; v_biz_a uuid; v_biz_b uuid;
begin
  select biz_a, biz_b into v_biz_a, v_biz_b from t_ids;

  -- Deliberately claims business B and a different author.
  insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason, created_by)
  select v_biz_b, branch_a, variant_a, 1, 'receive', '00000000-0000-0000-0000-000000000099' from t_ids;

  select business_id, created_by into v_biz, v_by
  from inventory_movements order by created_at desc, id desc limit 1;

  if v_biz <> v_biz_a then
    raise exception 'TEST FAILED: spoofed business_id survived (got %, expected %)', v_biz, v_biz_a using errcode = 'ZZ999';
  end if;
  if v_by <> '00000000-0000-0000-0000-000000000001' then
    raise exception 'TEST FAILED: spoofed created_by survived (got %)', v_by using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: business_id and created_by are overwritten from branch/session';
end $$;

-- ── 3. Stock cannot be driven negative by a manual adjustment ────────────

do $$
declare v_qty_before numeric; v_qty_after numeric; v_branch uuid; v_variant uuid;
begin
  select branch_a, variant_a into v_branch, v_variant from t_ids;
  select quantity into v_qty_before from stock_levels where branch_id = v_branch and variant_id = v_variant;

  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason, note)
    values ('00000000-0000-0000-0000-000000000000', v_branch, v_variant, -1000, 'adjustment', 'oops');
    raise exception 'TEST FAILED: an adjustment drove stock negative without being rejected' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: negative-stock adjustment rejected (%)', sqlerrm;
  end;

  select quantity into v_qty_after from stock_levels where branch_id = v_branch and variant_id = v_variant;
  if v_qty_after is distinct from v_qty_before then
    raise exception 'TEST FAILED: rejected adjustment still changed stock (% -> %)', v_qty_before, v_qty_after using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: rejected adjustment left stock unchanged at %', v_qty_after;
end $$;

-- ── 4. A zero delta is refused by the check constraint ───────────────────

do $$
begin
  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
    select '00000000-0000-0000-0000-000000000000', branch_a, variant_a, 0, 'adjustment' from t_ids;
    raise exception 'TEST FAILED: a zero-quantity movement was accepted' using errcode = 'ZZ999';
  exception
    when check_violation then
      raise notice 'PASS: zero-quantity movement rejected by check constraint';
  end;
end $$;

-- ── 5. record_stock_count(): absolute count becomes the right delta ──────

do $$
declare v_movement uuid; v_qty numeric; v_delta numeric; v_branch uuid; v_variant uuid;
begin
  select branch_a, variant_a into v_branch, v_variant from t_ids;
  -- Stock is 16 here (10 + 5 + the 1 from the spoofing test).

  select record_stock_count(v_branch, v_variant, 20, 'monthly count') into v_movement;
  if v_movement is null then
    raise exception 'TEST FAILED: counting 20 against 16 should have recorded a movement' using errcode = 'ZZ999';
  end if;

  select quantity_delta into v_delta from inventory_movements where id = v_movement;
  if v_delta is distinct from 4 then
    raise exception 'TEST FAILED: expected a +4 delta counting 20 against 16, got %', v_delta using errcode = 'ZZ999';
  end if;

  select quantity into v_qty from stock_levels where branch_id = v_branch and variant_id = v_variant;
  if v_qty is distinct from 20 then
    raise exception 'TEST FAILED: stock should be 20 after the count, got %', v_qty using errcode = 'ZZ999';
  end if;

  -- Counting the same number again is a no-op, not an error and not a row.
  select record_stock_count(v_branch, v_variant, 20, 'again') into v_movement;
  if v_movement is not null then
    raise exception 'TEST FAILED: a count matching current stock recorded a movement' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: record_stock_count computes the delta (+4 -> 20) and no-ops when it matches';
end $$;

-- ── 6. A count can take stock to zero, but not below ─────────────────────

do $$
begin
  begin
    perform record_stock_count((select branch_a from t_ids), (select variant_a from t_ids), -5, null);
    raise exception 'TEST FAILED: a negative counted quantity was accepted' using errcode = 'ZZ999';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: negative counted quantity rejected';
  end;
end $$;

-- ── 7. Reasons reserved for later phases are not insertable ──────────────

do $$
begin
  -- NOTE: 'sale' used to be asserted here as universally rejected. Since
  -- 0020 that is no longer the correct behaviour — the sales phase exists,
  -- and 'sale' is admitted for a caller holding sales.process. The rule
  -- that replaced it (allowed with the permission, refused without) is
  -- covered in tests/security/sales.sql. 'transfer_out' below is still
  -- genuinely reserved, because the transfers phase does not exist yet.

  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
    select '00000000-0000-0000-0000-000000000000', branch_a, variant_a, -1, 'transfer_out' from t_ids;
    raise exception 'TEST FAILED: a "transfer_out" movement was insertable before the transfers phase exists' using errcode = 'ZZ999';
  exception
    when insufficient_privilege then
      raise notice 'PASS: reserved reason "transfer_out" rejected by RLS';
  end;
end $$;

-- ── 8. stock_levels is not directly writable, even by the Owner ──────────

do $$
begin
  begin
    update stock_levels set quantity = 9999
    where branch_id = (select branch_a from t_ids);
    raise exception 'TEST FAILED: stock_levels was directly UPDATEable' using errcode = 'ZZ999';
  exception
    when insufficient_privilege then
      raise notice 'PASS: direct UPDATE on stock_levels refused (no grant)';
  end;

  begin
    insert into stock_levels (business_id, branch_id, variant_id, quantity)
    select biz_a, branch_a, variant_a, 9999 from t_ids;
    raise exception 'TEST FAILED: stock_levels was directly INSERTable' using errcode = 'ZZ999';
  exception
    when insufficient_privilege then
      raise notice 'PASS: direct INSERT on stock_levels refused (no grant)';
  end;

  begin
    delete from stock_levels where branch_id = (select branch_a from t_ids);
    raise exception 'TEST FAILED: stock_levels rows were directly DELETEable' using errcode = 'ZZ999';
  exception
    when insufficient_privilege then
      raise notice 'PASS: direct DELETE on stock_levels refused (no grant)';
  end;
end $$;

-- ── 9. The ledger is append-only ─────────────────────────────────────────

do $$
begin
  begin
    update inventory_movements set quantity_delta = 1;
    raise exception 'TEST FAILED: an inventory_movements row was UPDATEable' using errcode = 'ZZ999';
  exception
    when insufficient_privilege then
      raise notice 'PASS: UPDATE on inventory_movements refused (grant revoked)';
  end;

  begin
    delete from inventory_movements;
    raise exception 'TEST FAILED: an inventory_movements row was DELETEable' using errcode = 'ZZ999';
  exception
    when insufficient_privilege then
      raise notice 'PASS: DELETE on inventory_movements refused (grant revoked)';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 10. A Cashier can look but not touch ─────────────────────────────────
-- The seeded Cashier holds inventory.view but neither .receive nor .adjust.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000099';

do $$
declare v_visible int;
begin
  select count(*) into v_visible from stock_levels;
  if v_visible < 1 then
    raise exception 'TEST FAILED: cashier holds inventory.view but saw no stock levels' using errcode = 'ZZ999';
  end if;

  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
    select '00000000-0000-0000-0000-000000000000', branch_a, variant_a, 5, 'receive' from t_ids;
    raise exception 'TEST FAILED: cashier received stock without inventory.receive' using errcode = 'ZZ999';
  exception
    when insufficient_privilege then
      raise notice 'PASS: cashier blocked from receiving stock';
  end;

  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
    select '00000000-0000-0000-0000-000000000000', branch_a, variant_a, -5, 'adjustment' from t_ids;
    raise exception 'TEST FAILED: cashier adjusted stock without inventory.adjust' using errcode = 'ZZ999';
  exception
    when insufficient_privilege then
      raise notice 'PASS: cashier blocked from adjusting stock';
  end;

  begin
    perform record_stock_count((select branch_a from t_ids), (select variant_a from t_ids), 3, null);
    raise exception 'TEST FAILED: cashier recorded a stock count without inventory.adjust' using errcode = 'ZZ999';
  exception
    when insufficient_privilege then
      raise notice 'PASS: cashier blocked from recording a stock count';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 11. Cross-tenant isolation ───────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000042';

do $$
declare v_seen int;
begin
  select count(*) into v_seen from stock_levels;
  if v_seen <> 0 then
    raise exception 'TEST FAILED: business B owner saw % of business A''s stock rows', v_seen using errcode = 'ZZ999';
  end if;

  select count(*) into v_seen from inventory_movements;
  if v_seen <> 0 then
    raise exception 'TEST FAILED: business B owner saw % of business A''s movements', v_seen using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: business B owner sees none of business A''s inventory';

  -- Pointing a movement at business A's branch/variant: those rows are
  -- invisible to this session, so the context trigger reports them as
  -- not found rather than leaking their existence.
  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
    select biz_b, branch_a, variant_a, 100, 'receive' from t_ids;
    raise exception 'TEST FAILED: business B owner wrote a movement against business A stock' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0002' then
      raise notice 'PASS: cross-tenant movement rejected (branch/variant not visible)';
    when insufficient_privilege then
      raise notice 'PASS: cross-tenant movement rejected by RLS';
  end;

  -- Own branch, but another tenant's product.
  begin
    insert into inventory_movements (business_id, branch_id, variant_id, quantity_delta, reason)
    select biz_b, branch_b, variant_a, 100, 'receive' from t_ids;
    raise exception 'TEST FAILED: business B owner stocked business A''s product into their own branch' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0002' then
      raise notice 'PASS: foreign variant rejected (not visible to this tenant)';
    when sqlstate 'P0001' then
      raise notice 'PASS: foreign variant rejected (business mismatch)';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 11b. The path the application actually takes ─────────────────────────
-- The tests above pass a placeholder business_id because the column is
-- NOT NULL; the Server Actions omit it and rely on
-- set_inventory_movement_context() to fill it in (NOT NULL is checked
-- after BEFORE triggers). Worth proving rather than assuming.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_id uuid; v_biz uuid; v_biz_a uuid;
begin
  select biz_a into v_biz_a from t_ids;

  insert into inventory_movements (branch_id, variant_id, quantity_delta, reason, note)
  select branch_a, variant_a, 1, 'receive', 'omitted business_id' from t_ids
  returning id into v_id;

  select business_id into v_biz from inventory_movements where id = v_id;
  if v_biz is distinct from v_biz_a then
    raise exception 'TEST FAILED: omitted business_id resolved to % (expected %)', v_biz, v_biz_a
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a movement inserted without business_id (as the app does) is filled in correctly';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 12. The ledger still reconciles to the derived level ─────────────────
-- The real invariant behind this whole design: stock_levels must always
-- equal the sum of the movements that produced it.

do $$
declare v_mismatches int;
begin
  select count(*) into v_mismatches
  from stock_levels s
  where s.quantity is distinct from (
    select coalesce(sum(m.quantity_delta), 0)
    from inventory_movements m
    where m.branch_id = s.branch_id and m.variant_id = s.variant_id
  );

  if v_mismatches <> 0 then
    raise exception 'TEST FAILED: % stock_levels row(s) disagree with their movement history', v_mismatches using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: every stock level reconciles exactly to its movement ledger';
end $$;

\echo ''
\echo 'All inventory tests passed.'

'@
Set-Content -LiteralPath "tests/security/inventory.sql" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing tests/security/sales.sql"
New-Item -ItemType Directory -Force -Path "tests/security" | Out-Null
$content = @'
-- Busihub — behaviour/security test for sales (migration 0020).
--
-- The till is where the three ledgers meet, so most of these assert that a
-- REJECTED sale leaves nothing behind: no sale row, no stock movement, no
-- customer balance. A partial sale is worse than a refused one.
--
-- `TEST FAILED` raises carry SQLSTATE ZZ999, which no handler here catches
-- (the default, P0001, is caught below as an expected rejection).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000046',
   'authenticated', 'authenticated', 'ownerf@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000096',
   'authenticated', 'authenticated', 'auditor2@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000046';
select register_business('Sales Test Shop F', 'Adjoa', 'Nkrumah');
reset role;
reset request.jwt.claim.sub;

-- Business A: a standard-rated product and a zero-rated one.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select create_product(
  (select id from businesses where slug = 'busihub-demo-store'),
  'Sale Test Soap', null, 'Household', 'each', 'standard',
  '{}'::text[],
  '[{"sku": "SOAP-1", "barcode": "5901234123457", "variant_options": {}, "cost_price": 6, "selling_price": 100}]'::jsonb
);
select create_product(
  (select id from businesses where slug = 'busihub-demo-store'),
  'Sale Test Bread', null, 'Food', 'each', 'zero_rated',
  '{}'::text[],
  '[{"sku": "BREAD-1", "barcode": "", "variant_options": {}, "cost_price": 3, "selling_price": 50}]'::jsonb
);
reset role;
reset request.jwt.claim.sub;

create table s_ids as
select
  (select id from businesses where slug = 'busihub-demo-store')     as biz_a,
  (select id from businesses where slug = 'sales-test-shop-f')      as biz_f,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'busihub-demo-store') and b.is_main)  as branch_a,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'sales-test-shop-f') and b.is_main)   as branch_f,
  (select id from product_variants where sku = 'SOAP-1')            as soap,
  (select id from product_variants where sku = 'BREAD-1')           as bread;

do $$
declare r record;
begin
  select * into r from s_ids;
  if r.biz_a is null or r.biz_f is null or r.branch_a is null or r.branch_f is null
     or r.soap is null or r.bread is null then
    raise exception 'TEST FIXTURE BROKEN: s_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

grant select on s_ids to authenticated;

-- An Auditor (no sales.process) for the permission test.
do $$
declare v_biz uuid; v_branch uuid; v_role uuid;
begin
  select biz_a, branch_a into v_biz, v_branch from s_ids;
  select id into v_role from roles where business_id = v_biz and name = 'Auditor';
  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000096', v_biz, 'Read', 'Only2', 'auditor2@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);
  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000000096', v_role,
            '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;
end $$;

-- Stock to sell: 20 soap, 10 bread.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
select branch_a, soap, 20, 'receive' from s_ids;
insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
select branch_a, bread, 10, 'receive' from s_ids;

-- ── 1. A cash sale: totals, stock, receipt number ────────────────────────

do $$
declare
  v_sale uuid; v_s record; v_stock numeric; v_items int; v_price numeric;
begin
  select create_sale(
    (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null,
    'cash', 200,
    jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
  ) into v_sale;

  select * into v_s from sales where id = v_sale;

  if v_s.receipt_number <> 'R-000001' then
    raise exception 'TEST FAILED: expected receipt R-000001, got %', v_s.receipt_number using errcode = 'ZZ999';
  end if;

  -- Default settings: VAT 15%, levies 6%, tax-INCLUSIVE. A 100.00 shelf
  -- price therefore contains the tax rather than adding to it.
  if v_s.total <> 100.00 then
    raise exception 'TEST FAILED: an inclusive-priced item at 100.00 should total 100.00, got %', v_s.total
      using errcode = 'ZZ999';
  end if;
  -- The invariant that matters: the parts must sum to the whole exactly,
  -- with no stray pesewa from rounding each separately.
  if v_s.subtotal + v_s.tax_total <> v_s.total then
    raise exception 'TEST FAILED: % + % <> %', v_s.subtotal, v_s.tax_total, v_s.total using errcode = 'ZZ999';
  end if;
  if v_s.tax_total <= 0 then
    raise exception 'TEST FAILED: a standard-rated item recorded no tax' using errcode = 'ZZ999';
  end if;
  if v_s.change_given <> 100.00 then
    raise exception 'TEST FAILED: expected 100.00 change from 200 on a 100 sale, got %', v_s.change_given
      using errcode = 'ZZ999';
  end if;

  -- The price was taken from the catalog, not from the caller (there is
  -- no price parameter to pass at all).
  select unit_price into v_price from sale_items where sale_id = v_sale;
  if v_price <> 100.00 then
    raise exception 'TEST FAILED: unit_price should come from the catalog, got %', v_price using errcode = 'ZZ999';
  end if;

  select quantity into v_stock from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);
  if v_stock <> 19 then
    raise exception 'TEST FAILED: expected 19 in stock after selling 1 of 20, got %', v_stock using errcode = 'ZZ999';
  end if;

  if not exists (
    select 1 from inventory_movements
    where reference_type = 'sale' and reference_id = v_sale and reason = 'sale' and quantity_delta = -1
  ) then
    raise exception 'TEST FAILED: no stock movement linked back to the sale' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: cash sale — total %, tax %, change %, stock 20 -> 19, movement linked',
    v_s.total, v_s.tax_total, v_s.change_given;
end $$;

-- ── 2. A zero-rated item carries no tax ──────────────────────────────────

do $$
declare v_sale uuid; v_s record;
begin
  select create_sale(
    (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 50,
    jsonb_build_array(jsonb_build_object('variant_id', (select bread from s_ids), 'quantity', 1))
  ) into v_sale;

  select * into v_s from sales where id = v_sale;
  if v_s.tax_total <> 0 then
    raise exception 'TEST FAILED: a zero-rated item was taxed (%)', v_s.tax_total using errcode = 'ZZ999';
  end if;
  if v_s.total <> 50.00 or v_s.subtotal <> 50.00 then
    raise exception 'TEST FAILED: zero-rated totals wrong (subtotal %, total %)', v_s.subtotal, v_s.total
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a zero-rated item is untaxed and totals 50.00';
end $$;

-- ── 3. Not enough cash: nothing is written ───────────────────────────────

do $$
declare v_before int; v_after int; v_stock_before numeric; v_stock_after numeric;
begin
  select count(*) into v_before from sales;
  select quantity into v_stock_before from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);

  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 10,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
    );
    raise exception 'TEST FAILED: a sale completed with less cash than the total' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: insufficient cash rejected';
  end;

  select count(*) into v_after from sales;
  select quantity into v_stock_after from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);

  if v_after <> v_before then
    raise exception 'TEST FAILED: the rejected sale left a row behind' using errcode = 'ZZ999';
  end if;
  if v_stock_after is distinct from v_stock_before then
    raise exception 'TEST FAILED: the rejected sale still moved stock (% -> %)', v_stock_before, v_stock_after
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: the rejected sale left no row and no stock movement';
end $$;

-- ── 4. Overselling is blocked, and rolls the whole sale back ─────────────

do $$
declare v_before int; v_stock_before numeric; v_stock_after numeric;
begin
  select count(*) into v_before from sales;
  select quantity into v_stock_before from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);

  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 100000,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 999))
    );
    raise exception 'TEST FAILED: sold 999 of an item with 19 in stock' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: overselling refused (allow_negative_stock is false)';
  end;

  select quantity into v_stock_after from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);
  if v_stock_after is distinct from v_stock_before then
    raise exception 'TEST FAILED: refused oversale still changed stock' using errcode = 'ZZ999';
  end if;
  if (select count(*) from sales) <> v_before then
    raise exception 'TEST FAILED: refused oversale left a sale row' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: the refused oversale rolled back completely';
end $$;

-- ── 5. A multi-line sale where only the LAST line oversells ──────────────
-- The interesting case: the earlier lines succeed, then the sale fails.
-- Every one of them must be undone.

do $$
declare v_before int; v_bread_before numeric; v_bread_after numeric;
begin
  select count(*) into v_before from sales;
  select quantity into v_bread_before from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select bread from s_ids);

  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 100000,
      jsonb_build_array(
        jsonb_build_object('variant_id', (select bread from s_ids), 'quantity', 2),
        jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 999)
      )
    );
    raise exception 'TEST FAILED: a sale completed despite its second line overselling' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a sale failing on its second line is rejected';
  end;

  select quantity into v_bread_after from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select bread from s_ids);
  if v_bread_after is distinct from v_bread_before then
    raise exception 'TEST FAILED: the FIRST line''s stock was not rolled back (% -> %)',
      v_bread_before, v_bread_after using errcode = 'ZZ999';
  end if;
  if (select count(*) from sales) <> v_before then
    raise exception 'TEST FAILED: a partial sale row survived' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: the successful first line was rolled back with the rest';
end $$;

-- ── 6. Credit sales post to the customer ledger ──────────────────────────

do $$
declare v_cust uuid; v_sale uuid; v_balance numeric; v_total numeric;
begin
  insert into customers (business_id, name, phone, credit_limit)
  select biz_a, 'Till Credit Customer', '0201112223', 500 from s_ids
  returning id into v_cust;

  select create_sale(
    (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', v_cust, 'credit', 0,
    jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 2))
  ) into v_sale;

  select total into v_total from sales where id = v_sale;
  select balance into v_balance from customer_balances where customer_id = v_cust;

  if v_balance is distinct from v_total then
    raise exception 'TEST FAILED: balance % does not match the sale total %', v_balance, v_total
      using errcode = 'ZZ999';
  end if;
  if not exists (
    select 1 from customer_account_entries
    where reference_type = 'sale' and reference_id = v_sale and entry_type = 'sale'
  ) then
    raise exception 'TEST FAILED: no account entry linked back to the sale' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a credit sale of % lands on the customer''s account', v_total;
end $$;

-- ── 7. A credit sale needs a customer ────────────────────────────────────

do $$
begin
  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'credit', 0,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
    );
    raise exception 'TEST FAILED: a credit sale completed with no customer' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a credit sale without a customer is refused';
  end;
end $$;

-- ── 8. The credit limit stops a sale, and rolls it all back ──────────────

do $$
declare v_cust uuid; v_before int; v_stock_before numeric; v_stock_after numeric; v_balance numeric;
begin
  insert into customers (business_id, name, credit_limit)
  select biz_a, 'Tight Limit Customer', 50 from s_ids returning id into v_cust;

  select count(*) into v_before from sales;
  select quantity into v_stock_before from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);

  begin
    -- 2 x 100.00 = 200.00 against a 50.00 limit.
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', v_cust, 'credit', 0,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 2))
    );
    raise exception 'TEST FAILED: a credit sale exceeded the customer''s limit' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: a credit sale over the limit is refused';
  end;

  select quantity into v_stock_after from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);

  -- This is the important half: the stock had already been decremented
  -- inside the transaction before the limit check fired.
  if v_stock_after is distinct from v_stock_before then
    raise exception 'TEST FAILED: the refused credit sale still took stock (% -> %)',
      v_stock_before, v_stock_after using errcode = 'ZZ999';
  end if;
  if (select count(*) from sales) <> v_before then
    raise exception 'TEST FAILED: the refused credit sale left a sale row' using errcode = 'ZZ999';
  end if;
  select balance into v_balance from customer_balances where customer_id = v_cust;
  if coalesce(v_balance, 0) <> 0 then
    raise exception 'TEST FAILED: the refused credit sale moved the balance to %', v_balance using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: the over-limit sale rolled back stock, sale and balance together';
end $$;

-- ── 9. An archived product cannot be sold ────────────────────────────────

do $$
declare v_v uuid;
begin
  select bread into v_v from s_ids;
  update product_variants set status = 'archived' where id = v_v;

  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 1000,
      jsonb_build_array(jsonb_build_object('variant_id', v_v, 'quantity', 1))
    );
    raise exception 'TEST FAILED: an archived product was sold' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: an archived product cannot be sold';
  end;

  update product_variants set status = 'active' where id = v_v;
end $$;

-- ── 10. Receipt numbers increment ────────────────────────────────────────

do $$
declare v_sale uuid; v_ref text; v_n int;
begin
  select create_sale(
    (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 1000,
    jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
  ) into v_sale;
  select receipt_number into v_ref from sales where id = v_sale;
  select count(*) into v_n from sales;
  if v_ref <> 'R-' || lpad(v_n::text, 6, '0') then
    raise exception 'TEST FAILED: receipt % does not follow the sequence at % sales', v_ref, v_n
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: receipt numbers increment per business (%)', v_ref;
end $$;

-- ── 11. A completed sale is not editable ─────────────────────────────────

do $$
begin
  begin
    update sales set total = 1;
    raise exception 'TEST FAILED: a sale was UPDATEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: UPDATE on sales refused (grant revoked)';
  end;

  begin
    delete from sales;
    raise exception 'TEST FAILED: a sale was DELETEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: DELETE on sales refused (grant revoked)';
  end;

  begin
    update sale_items set quantity = 99;
    raise exception 'TEST FAILED: a sale line was UPDATEable' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: UPDATE on sale_items refused (grant revoked)';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 12. Without sales.process, no sale ───────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000096';

do $$
begin
  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000096', null, 'cash', 1000,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
    );
    raise exception 'TEST FAILED: an auditor rang up a sale' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a role without sales.process cannot sell';
  end;

  -- 0020 opened 'sale' movements and 'sale' account entries, which 0015
  -- and 0017 had reserved. They are gated on sales.process, not simply
  -- unlocked — this is the half of that rule those suites used to cover.
  begin
    insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
    select branch_a, soap, -1, 'sale' from s_ids;
    raise exception 'TEST FAILED: a role without sales.process wrote a "sale" stock movement'
      using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a "sale" movement still needs sales.process';
  end;

  begin
    insert into customer_account_entries (customer_id, amount, entry_type)
    select id, 10, 'sale' from customers where name = 'Till Credit Customer';
    raise exception 'TEST FAILED: a role without sales.process wrote a "sale" account entry'
      using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a "sale" account entry still needs sales.process';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 13. Cross-tenant isolation ───────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000046';

do $$
declare v_seen int;
begin
  select count(*) into v_seen from sales;
  if v_seen <> 0 then
    raise exception 'TEST FAILED: business F saw % of business A''s sales', v_seen using errcode = 'ZZ999';
  end if;

  -- Business A's product, sold into business F's own branch.
  begin
    perform create_sale(
      (select branch_f from s_ids), null, null, 'cash', 1000,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
    );
    raise exception 'TEST FAILED: business F sold business A''s product' using errcode = 'ZZ999';
  exception when sqlstate 'P0002' then
    raise notice 'PASS: another tenant''s product cannot be sold';
  end;

  raise notice 'PASS: business F sees none of business A''s sales';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 13b. allow_negative_stock is honoured, not just declared ─────────────
-- 0020 made the negative-stock rule read business_settings rather than
-- being hardcoded. That claim is only worth anything if the other branch
-- actually works, so both settings are exercised.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_stock_before numeric; v_stock_after numeric; v_sale uuid;
begin
  select quantity into v_stock_before from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);

  perform set_config('busihub.privileged_write', 'on', true);
  update business_settings
  set pos_settings = jsonb_set(pos_settings, '{allow_negative_stock}', 'true'::jsonb)
  where business_id = (select biz_a from s_ids);
  perform set_config('busihub.privileged_write', 'off', true);

  -- More than is on hand: now permitted, and the level goes negative.
  select create_sale(
    (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 1000000,
    jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids),
                                         'quantity', v_stock_before + 5))
  ) into v_sale;

  select quantity into v_stock_after from stock_levels
  where branch_id = (select branch_a from s_ids) and variant_id = (select soap from s_ids);

  if v_stock_after <> -5 then
    raise exception 'TEST FAILED: expected -5 on hand once negatives are allowed, got %', v_stock_after
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: with allow_negative_stock on, the sale completes and stock goes to -5';

  -- Put it back, and confirm the block returns.
  perform set_config('busihub.privileged_write', 'on', true);
  update business_settings
  set pos_settings = jsonb_set(pos_settings, '{allow_negative_stock}', 'false'::jsonb)
  where business_id = (select biz_a from s_ids);
  perform set_config('busihub.privileged_write', 'off', true);

  begin
    perform create_sale(
      (select branch_a from s_ids), '00000000-0000-0000-0000-000000000001', null, 'cash', 1000,
      jsonb_build_array(jsonb_build_object('variant_id', (select soap from s_ids), 'quantity', 1))
    );
    raise exception 'TEST FAILED: selling below zero was still allowed after turning the setting off'
      using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: turning the setting off restores the block';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 14. Everything still reconciles ──────────────────────────────────────

do $$
declare v_stock_mismatch int; v_bal_mismatch int; v_sale_mismatch int;
begin
  select count(*) into v_stock_mismatch
  from stock_levels s
  where s.quantity is distinct from (
    select coalesce(sum(m.quantity_delta), 0) from inventory_movements m
    where m.branch_id = s.branch_id and m.variant_id = s.variant_id);

  select count(*) into v_bal_mismatch
  from customer_balances b
  where b.balance is distinct from (
    select coalesce(sum(e.amount), 0) from customer_account_entries e
    where e.customer_id = b.customer_id);

  -- Each sale's stored totals must equal the sum of its own lines.
  select count(*) into v_sale_mismatch
  from sales s
  where (s.subtotal, s.tax_total, s.total) is distinct from (
    select (coalesce(sum(i.line_subtotal), 0), coalesce(sum(i.line_tax), 0), coalesce(sum(i.line_total), 0))
    from sale_items i where i.sale_id = s.id);

  if v_stock_mismatch <> 0 then
    raise exception 'TEST FAILED: % stock level(s) disagree with the ledger', v_stock_mismatch using errcode = 'ZZ999';
  end if;
  if v_bal_mismatch <> 0 then
    raise exception 'TEST FAILED: % balance(s) disagree with the ledger', v_bal_mismatch using errcode = 'ZZ999';
  end if;
  if v_sale_mismatch <> 0 then
    raise exception 'TEST FAILED: % sale(s) disagree with their own lines', v_sale_mismatch using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: stock, balances and sale totals all reconcile';
end $$;

\echo ''
\echo 'All sales tests passed.'

'@
Set-Content -LiteralPath "tests/security/sales.sql" -Value $content -NoNewline -Encoding UTF8

Write-Host ""
Write-Host "Done. 6 files written." -ForegroundColor Green
Write-Host ""
Write-Host "Next: npm run db:migrate   (applies migration 0020)" -ForegroundColor Yellow
Write-Host "Then: npm run typecheck; npm run lint; npm run test; npm run build" -ForegroundColor Yellow
