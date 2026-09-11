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
| 14 | Reports | **done — verified, see tests/security/reports.sql** (profit & loss, receivables ageing, stock valuation, sales report; print, WhatsApp text and CSV export) |
| 15 | Notifications | **done — in-app only, see changelog** (SMS/email deferred until a gateway/provider account exists; purchase-order and PIN-lockout alerts deferred to a later pass) |
| 16 | Offline/PWA | **partial — installability only, see changelog** (real app icons, manifest, and a static-asset-caching service worker with a branded offline fallback page; no offline sale queue — that's Phase 17) |
| 17 | Synchronization | **partial — mid-session resilience only, no visible connectivity indicator, see changelog** (a cash/credit sale rung up at the till while the connection drops mid-session queues on the device via IndexedDB and syncs automatically to `/api/sync` once reconnected, idempotently; opening or reloading `/till` from a cold start with no connection still doesn't work — that needs a whole separate offline catalog cache, deliberately scoped out — and there is no service-worker-driven Background Sync retry, by deliberate choice, not oversight; the "You're offline" / "N sales syncing" banner was removed on 2026-09-11 after repeated false-positives on real devices, see changelog — the queue and sync themselves are unaffected, there is just nothing on screen telling a cashier which state they're in) |
| 18 | Subscriptions & entitlements enforcement | pending |
| 19 | Super Admin | **done — full `/admin` console (layout guard + RLS backstop + audit logging), see supabase/migrations/0035_super_admin_console.sql** |
| 20 | Audit/security monitoring surfaces | **done — see app/(app)/settings/audit-log/page.tsx; coverage extended in the 2026-09 review to refunds/voids, branch and business-settings changes, and customer credit-limit changes (docs/SECURITY_AUDIT_2026-09.md)** |
| 21 | Automated test suite hardening | pending |
| 22 | Security review pass | **done — see docs/SECURITY_AUDIT_2026-09.md; both High-severity findings (auth rate limiting, refund/void audit logging) fixed in that pass, remaining items tracked there as backlog** |
| 23 | Performance review pass | **partial, brought forward ahead of Phase 15 at request — see changelog** (parallel-safety fix, redundant-lookup fix, and pagination on 3 of 4 unbounded list pages are done and verified; customers.tsx pagination and a real sale_payments/RLS scaling limit are measured and documented, not fixed) |
| 24 | Deployment prep & documentation | pending |

**This session's committed scope**: Phases 0–3 (architecture, schema, RLS,
auth, RBAC enforcement) to genuine production quality, forming the
foundation everything else is built on. Later phases continue in follow-up
work, phase by phase, with the same bar — implemented, tested, and verified
before being called done, per Section 2's completion definition.

---

## Changelog

- 2026-09-11 — Busihub brand identity pass, phase 5 of N (settings,
  staff & the admin console). Scope named directly by the user
  ("settings/staff/the admin console next").

  **What this phase touched** — every screen under `/settings` plus the
  Super Admin console at `/admin` (deliberately separate from the
  tenant app — see `app/admin/layout.tsx`'s own comment on why it does
  not share `AppShell`/`Sidebar`):

  - Settings: `audit-log/page.tsx`, `business/page.tsx`,
    `business-profile-form.tsx`, `business-settings-form.tsx`,
    `payments/page.tsx`, `paystack-form.tsx`,
    `regenerate-webhook-button.tsx` and `test-connection-button.tsx`
    (read, needed no changes), `pin/page.tsx`, `pin-form.tsx` (read,
    needed no changes), `service-providers/page.tsx`,
    `provider-form.tsx`, `service-providers/[id]/edit/page.tsx`,
    `service-providers/new/page.tsx`, `staff/page.tsx`,
    `staff/[id]/page.tsx`, `role-assignment-form.tsx` (read, needed no
    changes), `staff/new/page.tsx`, `invite-staff-form.tsx`.
  - Admin console: `admin/layout.tsx`, `admin/businesses/page.tsx`,
    `admin/businesses/[id]/page.tsx` (`admin/page.tsx` is a bare
    redirect with no markup of its own).

  Same treatment as phases 1-4: borders, dividers, row hovers, table
  headers, status badges, muted/secondary text, and card backgrounds
  moved onto the `surface`/`ink` tokens. No queries, RPCs, validation,
  or permission checks changed anywhere — confirmed by reading every
  file in full before editing; only className strings were touched.

  **This phase finally closes out the checkbox focus-ring deferral**
  first noted in phase 3: `settings/payments/paystack-form.tsx` was the
  third and last of the three files sharing the
  `dark:border-neutral-700 dark:bg-neutral-900` checkbox pattern (the
  other two, `products/product-form.tsx` and `sales/refund-form.tsx`,
  were retuned in phases 3 and 4). All three now use
  `dark:border-surface-line dark:bg-surface` consistently, with
  `focus:ring-brand-500/30` left alone on all three as before — nothing
  is inconsistent between them anymore.

  **Left deliberately alone**: the "Platform" pill in
  `admin/layout.tsx` (`bg-neutral-900 text-white ... dark:bg-white
  dark:text-neutral-900`) is an intentionally inverted badge, not a
  case of a background blending into the page — retuning it would
  remove the contrast it's designed to have. Decorative icon glyphs on
  bare `text-neutral-400` (e.g. the placeholder photo icons in
  `provider-form.tsx` and `service-providers/page.tsx`) were also left
  untouched, matching the precedent already set in phase 3's
  `product-photo-field.tsx`.

  Branches (`/branches`) sits under the "Operations" nav group rather
  than "Settings" (see `components/layout/nav-items.tsx`) and was not
  part of this phase's scope. The landing page, auth screens, and the
  marketing site remain untouched.

- 2026-09-11 — Busihub brand identity pass, phase 4 of N (customers,
  sales & reports). Scope named directly by the user ("customers/sales/
  reports next") rather than picked from a list.

  **What this phase touched** — every customer, sales/transaction, and
  reports screen:

  - Customers: `customers/page.tsx`, `customers/[id]/page.tsx`,
    `customers/customer-form.tsx`, `customers/account-entry-form.tsx`.
  - Sales: `sales/page.tsx`, `sales/[id]/page.tsx`,
    `sales/refund-form.tsx`, `sales/awaiting-payment.tsx` (one residual
    input background), `sales/[id]/receipt/page.tsx`,
    `sales/[id]/receipt/receipt-controls.tsx`.
  - Reports: `reports/page.tsx`, `reports/report-shell.tsx`,
    `reports/report-controls.tsx`, `reports/profit-loss/page.tsx`,
    `reports/receivables/page.tsx`, `reports/stock/page.tsx`,
    `reports/sales/page.tsx`.

  Same treatment as phases 1-3: plain grey dark-mode classes (borders,
  dividers, row/card hovers, table headers, muted/secondary text, card
  backgrounds) moved onto the `surface`/`ink` tokens. No queries, RPCs,
  validation, or permission checks changed anywhere — confirmed by
  reading every file in full before editing; only className strings
  were touched.

  **The receipt page is a deliberate exception, left alone on purpose.**
  `sales/[id]/receipt/page.tsx` renders the printed/shared slip inside a
  `.receipt-sheet` div styled `bg-white text-neutral-900` with **no**
  `dark:` variant on either — it is meant to look like paper on screen
  in both themes, not like the rest of the app. That was true before
  this phase and stays true after it; only the div's border
  (`dark:border-neutral-800` → `dark:border-surface-line`) was retuned
  to match the design system, since a border color is not part of the
  "looks like paper" contract the way the background/text colors are.

  **A new, smaller judgment call**: `reports/receivables/page.tsx` fades
  a zero-value aging column to `text-neutral-300` in light mode and had
  `dark:text-neutral-700` in dark mode — a near-invisible "nothing here"
  treatment. There is no token in the `surface`/`ink` system built for
  "deliberately almost invisible," so this was mapped to the same
  `dark:text-ink-muted` used everywhere else for secondary text, rather
  than inventing a new one-off token. It is slightly more visible than
  before; nothing has changed about the light-mode side.

  **Still explicitly deferred, unchanged from phase 3's note**: the
  checkbox in `sales/refund-form.tsx` had its border/background retuned
  (`dark:border-neutral-700 dark:bg-neutral-900` →
  `dark:border-surface-line dark:bg-surface`) but its focus-ring color
  (`focus:ring-brand-500/30`) was deliberately left alone, matching the
  same decision already made for `product-form.tsx` in phase 3. The
  third instance of this exact pattern, `settings/payments/
  paystack-form.tsx`, remains untouched and out of scope. A future pass
  can retune the ring color on all three together.

  Settings, staff, the admin console, auth screens, and the marketing
  site remain untouched.

- 2026-09-11 — Busihub brand identity pass, phase 3 of N (products &
  inventory). Scope picked by the user after phase 2 (dashboard) shipped.

  **What this phase touched** — every products and inventory screen:
  the list pages (`products/page.tsx`, `inventory/page.tsx`), detail
  pages (`products/[id]/page.tsx`, `inventory/[variantId]/page.tsx`),
  and every form (`product-form.tsx`, `variant-form.tsx`,
  `product-photo-field.tsx`, `categories/category-form.tsx`,
  `categories/page.tsx`, `inventory/stock-form.tsx`) — same treatment
  as phases 1-2: plain grey dark-mode classes (borders, dividers, row
  hovers, muted/secondary text, icon-chip backgrounds) moved onto the
  `surface`/`ink` tokens. No queries, RPCs, validation, or permission
  checks changed anywhere — confirmed by reading every file before
  editing; only className strings were touched.

  One category of fix specific to this phase: several of the search/
  filter `<input>`/`<select>` elements on the products and inventory
  list pages are hand-rolled native form controls (a plain HTML
  `<form action="/products">` GET search, not a client component).
  They never went through the shared `Field`/`Select` components phase
  1 retuned, so they'd been quietly left on the OLD styling the whole
  time — `dark:border-neutral-700 dark:bg-neutral-900 dark:text-white`
  and a `focus:ring-brand-500/30` ring, instead of the corrected
  `surface`/`ink` tokens and lime focus ring every other input in the
  app has had since phase 1. Retuned to match exactly, kept as native
  elements (not converted to `<Field>`/`<Select>`, which would have
  meant restructuring a working GET-search form for no functional
  gain).

  **Explicitly NOT done this phase**: the checkbox inputs in
  `product-form.tsx` ("This product comes in variants") had their
  grey border/background retuned, but their focus-ring color
  (`focus:ring-brand-500/30`) was deliberately left alone — the exact
  same styling exists on checkboxes in `sales/refund-form.tsx` and
  `settings/payments/paystack-form.tsx`, both out of scope for this
  phase, and retuning one but not the others would have made the
  inconsistency worse, not better. A future pass can address all three
  together. Customers, transactions, the dedicated report pages,
  settings, staff, the admin console, auth screens, and the marketing
  site remain untouched.

- 2026-09-11 — Busihub brand identity pass, phase 2 of N (dashboard).
  Scope picked by the user after phase 1 shipped and its sidebar/header
  border regression (see the follow-up fix under the phase-1 entry below)
  was fixed and confirmed live.

  **What this phase touched** — the dashboard route
  (`app/(app)/dashboard/page.tsx`, `sales-chart.tsx`) plus two shared
  primitives it (and most other pages) render through:

  - `app/(app)/dashboard/page.tsx` — every dark-mode class still reading
    plain desaturated grey (`neutral-800`/`900`/`500`/`300` for borders,
    dividers, hover backgrounds, and secondary text) moved onto the
    `surface`/`ink` tokens introduced in phase 1, matching what Card/
    Modal/Field already do — the stat cards, chart card, and list cards
    on this page all use `<Card>` already, so only what's DRAWN INSIDE
    those cards (table dividers, row hover, muted labels, progress-bar
    tracks) had been missed by phase 1's primitive-only sweep. No
    numbers, RPC calls, or permission checks changed — every figure on
    this page still comes from the same database functions listed at
    the top of the file, unre-touched.
  - Two real regressions from phase 1's exact-hex retune were found and
    fixed here, the same class of bug as the sidebar/header border
    issue: (1) the **dashboard hero card** (the first, dark "Net sales"
    stat tile) sets `bg-brand-950` and explicitly removes its own
    border (`dark:border-transparent`) — harmless when brand-950 differed
    from the page background, but now that they're the exact same
    `#082C24`, the hero card was disappearing into the page entirely in
    dark mode. Fixed the same way as the sidebar: `dark:border-surface-line`
    instead of `dark:border-transparent`. (2) The **active date-range/branch
    filter pill** used plain `bg-brand-950 text-white` with no dark-mode
    override, so the "active" pill was rendering the exact same color as
    the page behind it in dark mode — invisible. Given a dark-mode
    treatment matching the sidebar's own active-nav-item convention:
    `dark:bg-surface dark:text-lime-300`.
  - `components/ui/page-header.tsx` — the shared page title/description
    block every route renders through (not just the dashboard): title
    `dark:text-white` → `dark:text-ink`, description `dark:text-neutral-400`
    → `dark:text-ink-muted`. Reaches every screen the same way Button did
    in phase 1, for the same reason — one shared primitive, zero logic
    change.
  - `components/ui/skeleton.tsx` — `SkeletonBlock`'s dark background moved
    from plain `neutral-800` to `surface`, so a loading placeholder now
    reads as "a card that hasn't loaded yet" instead of a grey box that
    doesn't match anything else on a loaded page. Also reaches every
    route's `loading.tsx`, purely a color swap — the component's own
    "deliberately plain, no placeholder numbers" behavior is untouched.
  - `app/(app)/dashboard/sales-chart.tsx` — muted axis/legend text and
    the chart's zero-line stroke moved onto `ink-muted`/`surface-line`
    the same way. The bars themselves (`fill-brand-500` net,
    `fill-lime-500 dark:fill-lime-400` profit) needed no change — they
    already read the corrected token values from phase 1 automatically.

  **Explicitly NOT done this phase**: no count-up/entrance number
  animations on the stat cards (the brand spec's own "final validation"
  list mentions these as a candidate, not a requirement); no changes to
  `expenseCategories`' progress-bar fill color (`bg-neutral-400
  dark:bg-neutral-500`), left as a deliberately neutral (non-branded)
  bar rather than reached for consistency with the green payment-method
  bars — a style choice, not a defect, and left for a future pass if
  wanted. Products, inventory, customers, transactions, reports (the
  dedicated report pages, as opposed to the dashboard's own summary
  cards), settings, staff, the admin console, auth screens, and the
  marketing site remain untouched, same as phase 1.

- 2026-09-11 — Busihub brand identity pass, phase 1 of N (design tokens +
  POS/till + payment states). Context for why this exists as its own
  series, distinct from the "UI/UX polish pass" series later in this
  changelog (2026-09-07, phases 1-9): this app already went through an
  earlier color redesign (`abf2251` "dark green sidebar, lime accents,
  off-white canvas", `d5f6240` "phase 2: rest of the app, marketing
  site, dark mode toggle", `f643037` "make dark green the default
  theme") that was never written up here — this entry is also the first
  time that earlier work gets documented, alongside what changed in
  this pass on top of it.

  **What this phase actually touched** (deliberately scoped to the
  design-token foundation plus the two screens named first — the rest
  of the app, listed below, is unchanged and NOT yet in Busihub's exact
  brand palette):

  - `tailwind.config.ts` / `app/globals.css` — every color retuned to
    Busihub's exact brand hex values (previously close-but-not-exact,
    e.g. the sidebar was `#06271c`, not `#082C24`). Two real gaps beyond
    hex-precision were found and fixed, not just nudged: (1) the `lime`
    accent scale was a muted olive-green (`#b0d840` at its main shade),
    not the vivid "Busihub Lime Yellow" the brand actually calls for —
    the whole ramp was rebuilt around the real `#D9F21B`. (2) every
    dark-mode surface ABOVE the page background — Card, Modal,
    Field/Select/Textarea — used plain desaturated gray
    (`neutral-800`/`900`), unrelated to the forest-green identity, so
    dark mode read as "green sidebar, gray everything else." A new
    `surface` token group (`surface`/`surface-card`/`surface-line`/
    `surface-deep`, at `#0D3B32`/`#123F35`/`#28564B`/`#041A15`) and an
    `ink`/`ink-muted` text pair (`#F5F7F2`/`#B7C8C1`) replace that gray
    staircase everywhere those primitives render in dark mode. Light
    mode is unchanged apart from the hex-precision nudge (imperceptible
    — `#f7f6f2` to `#f5f7f2`).
  - `components/ui/button.tsx` — primary buttons are now lime-yellow
    with dark text (was dark-green with white text) per the brand spec's
    explicit rule that the app's one "do the main thing" color is the
    accent, not the structural dark green; a new `outline` variant was
    added (transparent + bordered) alongside the existing
    primary/secondary/danger/ghost. This is the one change in this pass
    that reaches every screen rather than just till/payments, since
    Button is shared everywhere — Complete Sale, Save, Add Product, Pay
    all read this from one definition.
  - `components/ui/card.tsx`, `modal.tsx`, `field.tsx`, `select.tsx`,
    `textarea.tsx`, `badge.tsx` — dark-mode surfaces/borders/text moved
    onto the new `surface`/`ink` tokens; form focus rings moved from a
    green (`brand-500`) ring to the lime accent, matching the brand
    spec's "focus uses the accent" rule. `Card` also gained a subtle
    `hover:-translate-y-px` lift for `hoverable` cards (motion-reduce
    respected). Semantic colors (success/warning/danger/info) were left
    on Tailwind's stock scales, unchanged, per this codebase's existing
    "reuse stock scales for semantics" rule (see badge.tsx) — those
    already sit close to the brand spec's success/error/warning hex.
  - `components/layout/sidebar.tsx` — one narrow, surgical change: the
    active-nav-item background moved from a generic `white/10` overlay
    to the brand spec's actual named "Active item" color (`surface`,
    `#0D3B32`). It inherited the retuned `brand-950` background
    automatically, since it already read that shared token rather than
    a hardcoded hex (see the follow-up fix below for a border regression
    that retune introduced).
  - `app/(app)/till/till.tsx` — the POS/till motion system: cart lines
    now animate in on add (`animate-slide-up`, plays automatically on
    mount, no extra state needed) and animate out on removal (a genuine
    two-step exit: `setQuantity` marks a line "removing," lets a 180ms
    CSS transition collapse it, then actually drops it from state — see
    `CART_EXIT_MS` and `activeCart`). `activeCart` (cart minus
    mid-removal lines) is what every total, stock check, and the
    submitted `cartJson` now reads, not `cart` directly, so the total a
    cashier sees updates instantly on removal even though the line is
    still visibly fading out — the animation was not allowed to lag
    the number behind it. A quantity bump/decrement gets a quick "pop"
    (remounting the number under a `key={line.quantity}`, which is
    what makes a fresh CSS animation play on every tap — no manual
    animation-state tracking needed there). Scanning a barcode via the
    camera modal now confirms with a toast naming the product (the
    hardware-scanner-into-search-box path deliberately does NOT toast
    on every hit — a cashier scanning several items a minute doesn't
    need one popup per item when the cart's own entrance animation
    already shows it landed). Search results and product tiles got
    `active:scale` press feedback and the new lime/surface hover
    treatment. No business logic changed: every dollar figure, stock
    check, and validation rule computes exactly as before — only what
    was fed into "which lines count right now" was clarified, and only
    because the new removal animation made that ambiguous for the
    first time.
  - `app/(app)/sales/awaiting-payment.tsx` — the payment-status waiting
    screen got an entrance fade and its plain pulsing dot became a
    layered ping-ring + solid dot (both Tailwind's built-in
    `animate-ping`/`animate-pulse`, no new keyframes). This is
    presentation only: the actual state machine (waiting → declined →
    completed) and its polling/webhook logic were not touched, and
    "completed" still only ever renders once the server has verified
    the charge — nothing here can show success before that.
  - `components/ui/barcode-scanner-modal.tsx` — a decorative viewfinder
    overlay (corner brackets + a sweeping scan line, all `pointer-events-none`)
    was added on top of the camera preview, and the panel now
    fades/slides in with the shared `animate-fade-in`/`animate-slide-up`
    pair. The actual `@zxing/browser` decode loop underneath — device
    enumeration, constraints, the frame callback — was not touched.
  - Two new keyframes in `tailwind.config.ts` for the above:
    `qty-pop` (150ms scale bump) and `scan-line` (1.8s sweep,
    decorative only). Both inherit the existing global
    `prefers-reduced-motion` blanket override in `app/globals.css`
    (durations collapse to near-zero) the same way every other
    animation in this app already does, rather than needing their own
    override.

  **Explicitly NOT done this phase** — named here rather than left
  implicit, so nobody mistakes "till and payments are retuned" for "the
  whole app is": the dashboard, products, inventory, customers,
  transactions/sales list, reports, expenses, suppliers, branches,
  settings, staff, the admin console, auth screens (login/register/
  etc.), and the public marketing site all still render with the
  *previous* redesign's colors (dark green + the old muted-olive
  accent) wherever they don't happen to route through a primitive
  retuned in this pass (Button/Card/Modal/Field/Select/Textarea/Badge
  do reach most of those screens indirectly, so many of them will
  already look closer to on-brand than before — but none of those
  screens' own bespoke styling was reviewed or touched). No count-up
  stat animations, no dashboard entrance animations, no landing-page
  animations, no light-mode elevation-token pass, and no receipt-page
  success-checkmark treatment exist yet. These are candidates for
  later phases of this same series, not abandoned.

  **Follow-up fix, same day** — retuning `brand-950` to the exact
  `#082C24` earlier in this pass had a side effect nobody caught until
  it was live: `brand-950` (the sidebar's background) and
  `canvas.dark` (the main content background, in dark mode) are both
  `#082C24` — the same hex, exactly. Before this pass they were two
  different dark greens with enough natural contrast to read as
  separate zones; retuned to the brand's precise values, they became
  identical, so the sidebar, header, and page content fused into one
  undifferentiated dark-green field with no visible seam anywhere.
  Fixed by adding a `border-r` to the sidebar (`components/layout/
  sidebar.tsx`) and a `border-b` to the sticky header
  (`components/layout/app-shell.tsx`), both using `surface-line`
  (`#28564B`) — the brand spec's own named "Border" color, already used
  the same way on Card/Modal/Field. The header also gets a light-mode
  border (`neutral-200/70`) for the same reason, since it previously had
  none there either. No layout, spacing, or functional change — purely
  the missing dividing lines.

- 2026-09-11 — Phase 17 (Synchronization), client half — the
  "You're offline" banner was removed rather than fixed a fifth time.
  The entry below this one describes a fourth attempt at
  `lib/offline/use-online-status.ts` that fixed a real, confirmed race
  condition — but real-device retesting after it shipped still showed
  the banner reading "You're offline" immediately on a fresh app open
  with a genuinely working connection. That's four rounds (DevTools-only
  event handling, then polling `navigator.onLine`, then a reachability
  probe, then a corrected version of that probe) where each fix solved
  the specific failure mode it was built for and real devices still
  found another one. Rather than ship a fifth guess, `<ConnectionStatus
  />` was removed from `app/layout.tsx` so the banner stops rendering
  anywhere, full stop — it can no longer show wrong information because
  it doesn't show anything. This is a product decision, not a technical
  fix: client-side network detection (`navigator.onLine`, reachability
  probes, the `online`/`offline` events) has proven unreliable enough
  across real browsers and devices in this app's testing that no
  amount of polling or probing found this session has produced a
  trustworthy enough signal to put in front of a cashier.
  `components/ui/connection-status.tsx` and `lib/offline/use-online-status.ts`
  are both left in place, working and still unit-tested — nothing about
  them was wrong on their own terms, they just were never fed a reliable
  enough input. Re-mounting the banner later needs only
  `<ConnectionStatus />` back in the layout, once (if ever) a genuinely
  reliable connectivity signal is found. **What did NOT change**: the
  till (`app/(app)/till/till.tsx`) reads `useOnlineStatus()` directly,
  independently of the banner, to restrict payment methods to
  cash/credit and to queue sales locally instead of submitting them
  live — that logic, and the underlying IndexedDB queue and
  `/api/sync` flush, are unaffected by removing the banner and continue
  to work exactly as verified in the entries below. The one open
  question this doesn't resolve: if the same detection is unreliable
  enough to mislead a banner, it could in principle also mislead the
  till's own online/offline branching (e.g., wrongly treating a
  reachable connection as unreachable and queuing a sale that could
  have gone through live, or the reverse). That has not been reported
  as a symptom so far — every offline-till test this phase has queued
  and synced correctly — but it is now flagged here explicitly as an
  assumption riding on the same signal, rather than left implicit.

- 2026-09-11 — Phase 17 (Synchronization), client half — fourth
  follow-up, and the first one not diagnosed from a written report: the
  previous entry's reachability probe was reproduced live, directly
  against the deployed production site's public homepage (no login
  needed — `ConnectionStatus` renders from the root layout, so it's on
  every route), using direct browser automation rather than waiting on
  another round of screen photos. That session's network log showed
  the HEAD probe to `/manifest.webmanifest` genuinely succeeding
  (`200 OK`, confirmed twice, stack trace pointing at the real deployed
  bundle) and the banner still reading "You're offline" a full second
  and a half later. Service-worker interference, a stray
  `AbortController.abort()`, and the fetch logic itself were each ruled
  out in turn by testing them in isolation in that same session, which
  narrowed it down to the request-id "newest result wins" guard added
  in the previous fix: a slower, unrelated probe (ordinary hydration
  churn was observed cancelling in-flight requests on its own) could
  still resolve after a successful one and overwrite it, since
  "arrived last" isn't the same as "most trustworthy" once transient
  failures are possible. `lib/offline/use-online-status.ts` no longer
  treats "online" and "offline" symmetrically: a probe can now only
  ever raise the state to true (applying a success is idempotent, so
  there's no ordering left to race), and the only thing trusted to
  lower it to false is the browser's own `offline` event, which was
  never the part that misbehaved across any of the last three fixes —
  only the *recovery* side kept failing. `navigator.onLine` still seeds
  the very first render so a page opened while genuinely offline
  doesn't have to wait on a probe to say so, but no longer overrides a
  later success. Nothing about the queue, sync flow, or till behavior
  changed.

- 2026-09-11 — Phase 17 (Synchronization), client half — third
  follow-up. The previous entry's `navigator.onLine`-polling fix held up
  under Chrome DevTools testing on desktop, but the banner still got
  stuck saying "You're offline" on a real phone with confirmed working
  internet (other sites loading fine, reproduced in more than one
  browser on that same device). That rules out a per-browser bug and
  points somewhere lower: `navigator.onLine` itself getting stuck at the
  OS/network-stack level — a real, documented limitation on some Android
  devices, where the flag can stay stale after a network interface
  flaps, independent of which browser reads it. Polling a flag that's
  wrong doesn't help; the flag needed to stop being the source of truth.
  `lib/offline/use-online-status.ts` now verifies actual reachability
  with a real `fetch` (HEAD, `cache: "no-store"`) against
  `/manifest.webmanifest` — a tiny, already-precached, unauthenticated
  static file — every 5 seconds, rather than trusting `navigator.onLine`
  for the "yes we're online" answer. `navigator.onLine` is still checked
  first as a free, instant short-circuit for the confident "definitely
  no network interface" case, and the `offline` event still flips the
  state immediately rather than waiting for the next probe; only the
  positive "we're online" signal now has to be earned by an actual round
  trip. A request-id guard prevents a slow probe from an earlier tick
  landing after a newer one and briefly flipping the state backwards.
  Nothing else about the queue, sync flow, or till behavior changed.

- 2026-09-11 — Phase 17 (Synchronization), client half — second
  follow-up: the hard-reload bug from the entry below was confirmed
  fixed by an actual real-browser retest (the till survived sitting
  offline well past 45 seconds, queued a sale, and showed the
  count-aware banner text correctly). The separate observation from
  that same round — the bottom banner staying on "You're offline" even
  after switching DevTools' Network conditions back to "No throttling,"
  confirmed with a screenshot showing the dropdown clearly set to "No
  throttling" while the banner still read offline — turned out to be
  real, and traced to `lib/offline/use-online-status.ts`: Chrome
  DevTools' network-condition emulation does not reliably fire a real
  `online` event when switching away from "Offline" without a full page
  reload, so a hook that only listens for that event can get stuck.
  `navigator.onLine` itself still updates correctly even when the event
  doesn't fire, so the hook now also re-checks it directly every 3
  seconds as a fallback, on top of (not instead of) the existing event
  listeners — a real device regaining a genuine connection still
  updates instantly through the event; this only adds a few seconds of
  latency for the specific case the event misses. Nothing else changed.

- 2026-09-11 — Phase 17 (Synchronization), client half — follow-up fix
  found during real-browser verification of the entry below, not just a
  lint cleanup this time. Throttling the network to Offline in DevTools
  and leaving the till sitting there (rather than acting immediately)
  reproduced a genuine failure: the till was silently knocked back to
  the static `public/offline.html` fallback with no warning, wiping the
  in-progress cart before the offline queue ever got a chance to help.
  Root cause was two background requests that kept firing regardless of
  connection state and had nothing to do with the till itself:
  `components/notifications/notification-bell.tsx`'s 45-second poll (a
  Server Action call) and Next's own default behavior of prefetching
  every `<Link>` the moment it's in the viewport — which, in
  `components/layout/sidebar.tsx`, is all of them, all the time, since
  the sidebar never leaves the screen. A request that fails outright
  (no connection at all, not the server returning an error) is treated
  by Next's App Router the same way as a stale-deployment error, and it
  can fall back to a full, hard page reload to recover — which the
  service worker then answers with offline.html, per its own "page
  navigation fails while offline" branch (public/sw.js), exactly as
  designed for a real navigation. Nothing about that fallback is wrong;
  the bug was in making requests that could trigger it while sitting
  idle on a page that was never asked to go anywhere.
  Fixed by not making those requests while offline: the notification
  bell now checks `useOnlineStatus()` before scheduling its poll (and
  its `refresh()` is now wrapped in try/catch instead of leaving a
  network failure as an unhandled rejection), and every sidebar `<Link>`
  now sets `prefetch={false}` — an explicit click still fetches fresh
  on demand exactly as before; only the always-on background prefetch
  is gone. Both are small, targeted fixes, not a redesign — nothing
  about the queue, the sync flow, or the till's own submit handling
  changed. Still to be re-verified in a real browser: whether the till
  now survives sitting offline for longer than 45 seconds without being
  knocked back to the fallback page, and whether the connection banner
  correctly clears once the browser reports being back online (a second,
  separate observation from this same test round that isn't yet
  explained — worth a clean, isolated retest before assuming it's fixed
  by the above, since neither change directly touches
  `lib/offline/use-online-status.ts` or `connection-status.tsx`).

- 2026-09-11 — Phase 17 (Synchronization), client half — scoped to
  "mid-session resilience," not full offline support, after weighing two
  options directly with the business owner: either the till survives a
  connection drop while it's already open (using the catalog already
  loaded in the browser), or the till works from a cold start with no
  connection at all (which would mean caching the whole product/customer
  catalog client-side and reworking how the till page fetches its data —
  a much larger change to the core money-handling screen). The narrower
  option was chosen; opening or reloading `/till` still needs a live
  connection exactly as before, unchanged by anything in this entry.
  `lib/offline/queue.ts` (new) is an IndexedDB-backed outbox for sales
  rung up while offline, keyed on the same `client_transaction_id`
  `create_sale()`'s idempotency check (0052) is keyed on.
  `lib/offline/sync.ts` (new) drains it into `/api/sync` in one batch, reconciling per
  item: a sale the server confirms is removed, one it rejects keeps its
  place with the server's own message attached, and a request that never
  gets a response leaves the whole queue untouched (so this is always
  safe to call speculatively). `lib/offline/use-online-status.ts` and
  `lib/offline/use-pending-sync.ts` (new) are the two hooks that drive
  it: a shared `online`/`offline` listener (till.tsx and the connection
  banner both use it now instead of each keeping their own), and the one
  place that decides when to try flushing the queue — once on mount, and
  again every time the browser fires `online`.
  `app/(app)/till/till.tsx` (updated): while offline, the Payment picker
  drops mobile money and split (0052 refuses these for a synced sale
  too, for the same underlying reason — a phone can't be prompted for a
  charge on a sale that hasn't reached a server yet), a stale momo/split
  selection made before the connection dropped resets to cash
  automatically, and submitting queues the sale locally instead of
  calling completeSale() — with the same "not enough cash tendered" and
  "credit needs a customer" checks the server would otherwise catch,
  since there's no round trip left to catch them for it. A
  `queuedThisSession` map subtracts each tab's own not-yet-synced quantities from
  the stock figures it displays, so ringing up several offline sales in
  a row doesn't keep showing stock that's already spoken for — a
  courtesy display only, not a real reservation (another till, or a
  reload of this one, has no way to know about it, and the server itself
  still lets a synced sale oversell rather than refuse it).
  `components/ui/connection-status.tsx` (updated): no longer renders
  nothing while online — if the queue isn't empty it now shows how many
  sales are waiting, syncing, or stuck, with a manual "Sync now" button.
  The offline copy also changed to say how many sales are saved on the
  device when the queue isn't empty, instead of the previous blanket
  "won't work until you reconnect," which stopped being fully true the
  moment this shipped.
  Left out, on purpose: a Background Sync API `sync` event registration
  in `public/sw.js`, which would let a queued sale retry even with every
  tab closed. Building it properly would mean a second copy of the same
  queue/flush logic hand-written in plain, unbundled JS (a service
  worker can't import this app's TypeScript module graph), for a
  browser API with no support in Safari/iOS at all. A till isn't
  normally closed mid-shift, so retrying when a tab notices it's back
  online (or a cashier taps "Sync now") covers the realistic case — the
  harder, riskier mechanism was deliberately left out rather than half-
  built. There is also still no way to edit or discard a sale stuck in
  the queue from the UI — if a queued sale keeps failing to sync (an
  item deleted since, say), it sits there showing its error until the
  underlying problem is fixed or a developer clears it directly; a
  management view for the queue is a reasonable follow-up, not something
  this pass built.
  `lib/validation/offline-sync.ts` gained no new fields (unchanged from
  the backend pass) but `tests/unit/offline-sync-validation.test.ts`
  (new) is the first automated coverage for it — the pure zod schema
  logic is testable under Vitest's node environment; the IndexedDB/fetch
  code in lib/offline/*.ts is not (no jsdom/fake-indexeddb in this
  project's test setup, and none was added for this — consistent with
  this codebase's general reluctance to reach for a new dependency), so
  that half was verified by hand-reviewing every import against the
  files it actually calls, the same way app/api/sync/route.ts was in the
  backend pass. It still needs the same real-browser verification (throt-
  tling the network in DevTools, ringing up an offline sale, watching it
  sync) that automated tests can't reach here.

- 2026-09-10 — Phase 17 (Synchronization), backend half only. Migration
  `0052_offline_sync.sql` extends `create_sale()` with a trailing
  `p_client_transaction_id` parameter (every existing call site is
  unaffected — it defaults to null): passing one makes the call
  idempotent (a replay with the same id, scoped per business by a partial
  unique index, returns the original sale instead of creating a second
  one), refuses a `momo` tender outright (a phone cannot be prompted for
  a charge after the fact), and — because a sale that already happened at
  the till cannot be refused retroactively — lets its stock movement land
  negative under a new `sale_synced` reason regardless of the business's
  `allow_negative_stock` setting, which stays untouched for the ordinary
  online path. The shortfall is recorded, not silently absorbed: a new
  `inventory_negative_from_sync` notification type, written directly by
  the already-`SECURITY DEFINER` `apply_inventory_movement()` trigger and
  visible to `inventory.view` holders through their own scoped SELECT
  policy (added as a separate policy, not a widened clause on the
  existing one — see the migration's own comment on why, it's the exact
  regression a first draft of this introduced and testing caught).
  `app/api/sync/route.ts` (new) is the Route Handler a browser-side
  offline queue will eventually POST a batch of queued sales to: ordinary
  session auth (never service-role), `requirePermission` up front,
  payment method restricted to cash/credit before `create_sale` is even
  called, each queued sale processed independently so one bad item
  doesn't block the rest of the batch. `tests/security/offline_sync.sql`
  (new) covers idempotent replay, per-business uniqueness of the
  idempotency key, a synced oversell landing and notifying correctly, the
  online path staying refused on the same stock, the momo refusal, the
  `sale_synced` insert policy, and cross-tenant isolation for all of it —
  built and run against a real local Postgres instance (all 20 security
  test suites, existing and new, pass with zero regression) before any
  of this was written up.
  What this is NOT: there is still no offline sale queue anywhere in the
  browser. Nothing generates a `client_transaction_id`, queues a sale in
  IndexedDB, restricts the till to cash/credit while offline, extends
  `public/sw.js` with a `sync` event, or shows "N sales pending sync" —
  `/api/sync` has no caller yet. That client-side half is deliberately
  separate follow-up work, built against a database layer proven first
  rather than the other way around.

- 2026-09-10 — Phase 16 (Offline/PWA), installability only. Requested
  directly, scoped down from the full Section 7 offline-sync design after
  flagging the split: the roadmap already separates "Offline/PWA" (this)
  from "Synchronization" (Phase 17, still pending) precisely because the
  latter touches money and inventory integrity and needs its own DB
  migration, new `/api/sync` route, and conflict handling — none of that
  changed here.
  `public/icons/README.md` had said outright that real app icons were
  "generated in the PWA phase... once Busihub has real brand artwork" and
  nothing had come back to do it; generated icon-192/512.png (regular)
  and icon-maskable-192/512.png (full-bleed, safe-zone padded for
  Android's adaptive-icon mask) plus `app/apple-icon.png` (Next's file
  convention for iOS "Add to Home Screen"), all the same lime-on-
  brand-950 "B" mark already used in the sidebar and marketing navbar.
  `app/icon.tsx` (the dynamic favicon route) was still `bg-brand-600`
  (`#158459`) with white text — the original pre-redesign color, missed
  by both UI/UX polish passes since it renders as a route rather than
  showing up in a grep for the old Tailwind class name — now matches the
  same mark. `public/manifest.webmanifest`'s `background_color`/
  `theme_color` updated from white/`#22a56d` to the redesign's
  `#0a1a13`, and the two maskable icon entries added.
  `public/sw.js` (new) is a small, hand-rolled service worker —
  deliberately not workbox/next-pwa, since that would mean asking the
  project to `npm install` a new dependency, and this session had
  already hit one real build failure from a network-dependent build step
  (`next/font/google`, see the redesign entries below). It caches the
  Next.js build's own static assets (content-hashed, so cache-first is
  safe) and serves a new `public/offline.html` instead of the browser's
  own connection-error screen when a page navigation fails offline.
  Every Supabase call, every Server Action (all POSTs — this only ever
  looks at GETs), and every RSC data fetch passes straight through
  untouched; nothing is cached or replayed. `components/pwa/register-
  service-worker.tsx` registers it once on mount, production-only.
  `components/ui/connection-status.tsx` (new) is a small banner shown
  only while `navigator.onLine` is false, wired into the root layout so
  it covers the app, auth, and marketing pages alike — worded narrowly
  ("won't work until you reconnect") rather than implying queued work
  will sync later, since that capability doesn't exist yet.

- 2026-09-07 — First remediation pass from the 2026-09 full-codebase
  security review (`docs/SECURITY_AUDIT_2026-09.md`, Phase 22). Both
  High-severity findings fixed:
  - **Rate limiting / lockout** (migration `0048_auth_rate_limiting.sql`,
    `lib/auth/rate-limit.ts`): `login()`, `switchTillUser()`, and
    `requestPasswordReset()` previously called Supabase Auth directly with
    no attempt counter or lockout at all. Now locked the same shape
    cashier PIN entry already had (0039) — 8 failed attempts / 15-minute
    lockout for real password sign-ins, a 3-request/15-minute limiter for
    password-reset requests (which can't use success/failure, since that
    endpoint must not reveal whether an email exists either way).
  - **Refund/void audit logging** (migration
    `0049_audit_log_gaps.sql`): `void_sale()` and `create_refund()` never
    wrote to `audit_logs`, despite being the classic point-of-sale fraud
    vector and every other sensitive action already being logged. Both
    now write a `sale.voided` / `sale.refunded` row in the same
    transaction as the reversal itself.

  Several Medium-severity gaps fixed in the same pass: `void_expense()`
  now logs `expense.voided`; `updateCustomer()`, `createBranch()`/
  `updateBranch()`, and `updateBusinessProfile()`/`updateBusinessSettings()`
  now log their respective events too (`app/(app)/customers/actions.ts`,
  `app/(app)/branches/actions.ts`, `app/(app)/settings/business/actions.ts`);
  and `tests/security/products_cross_tenant.sql` adds the direct
  cross-tenant denial test `products`/`product_variants` previously only
  had indirect coverage for.

  Two items from the review were deliberately NOT auto-fixed here because
  they are product/scope decisions, not bug fixes — see
  `docs/SECURITY_AUDIT_2026-09.md` for both: whether to build real
  sale-time enforcement for the discount-cap setting (or correct the
  landing page's claims about it), and whether to wire up
  `app_has_branch_permission()`/`requireBranchPermission()` or explicitly
  document branch id as data-scoping-only. The CSP's `'unsafe-inline'` and
  a couple of low-priority hygiene items also remain open, tracked in that
  doc rather than fixed blind.

  `lib/supabase/env.ts` was deliberately left WITHOUT an `import
  "server-only"` guard despite the review suggesting one for it alongside
  `lib/supabase/server.ts` (which did get the guard, since it really is
  100% server-only code): `env.ts` also exports `supabaseUrl()`/
  `supabaseAnonKey()`, which `lib/supabase/client.ts` — a `"use client"`
  file — genuinely needs. Adding `server-only` there would break the
  client bundle. `supabaseServiceRoleKey()`'s actual value was never
  reachable from client code regardless, since only `NEXT_PUBLIC_`-
  prefixed env vars are bundled to the browser — this was a documentation-
  consistency nit, not an exploitable gap, and is noted here rather than
  applied incorrectly.

- 2026-09-07 — Fixed a broken CI assertion in `tests/security/payments.sql`
  section 26 ("One shop cannot touch another shop's webhook identifier"),
  added alongside migration `0047` below. It looked up "business B" —
  `select id into v_other from businesses where id <> biz_a limit 1` —
  while already `set role authenticated` as business A, and got `null`
  back. That is not the seed having only one business; `businesses_select`
  (0009) and `business_payment_settings_select` (0022) both scope `select`
  to the caller's own business, so RLS hid business B from business A's
  own session before the test ever got to the thing it meant to check.
  Section 22, right above it, does the equivalent lookup as `service_role`
  for exactly this reason and was never affected. The fix follows that
  same shape: look up business B and its current `webhook_identifier` as
  `service_role`, stash both in session GUCs (`busihub.test_other_business`,
  `busihub.test_other_webhook_id` — the same `set_config(..., false)` /
  `current_setting(...)` pattern sections 3, 11, 16 and 22 already use to
  carry a value across a role switch), then read them back once switched
  to business A to attempt — and confirm the refusal of — the actual
  cross-tenant `regenerate_paystack_webhook_identifier()` call. The
  "nothing changed" recheck afterwards also moved to `service_role`, for
  the same reason: business A's own session cannot see business B's row
  to confirm it, changed or not. No application code changed; this was a
  bug in the new test's own fixture-visibility assumption, caught by CI's
  `psql`-run security suite exactly as intended (`npm test` never runs
  these `.sql` files, so this could not have been caught locally).

- 2026-09-07 — The three remaining additive Paystack items (migration
  `0047`): a webhook identifier separate from `business_id`, audit-log
  entries for payment-settings changes, and a live-mode confirmation
  checkbox. Picking up exactly where the "Test connection" entry below
  left off — those three were offered and deferred at the time; this is
  them getting built.

  **Webhook identifier.** `business_payment_settings.webhook_identifier`
  (a `gen_random_uuid()`, same as every other opaque id in this schema)
  replaces `business_id` as the value in a shop's webhook URL. Nothing was
  actually broken before this — the HMAC signature, not the URL, is what
  authenticates a webhook — but a `business_id` shows up in plenty of
  ordinary application URLs, while this value is meant to appear nowhere
  else, and unlike a `business_id` it can be thrown away and reissued.
  There is deliberately no UPDATE grant on the column at all;
  `regenerate_paystack_webhook_identifier()` (`security definer`, gated on
  `business.manage`) is the only door in, matching the shape of every
  other sensitive write path in this schema. The webhook route
  (`resolveBusinessIdFromWebhookParam` in `lib/paystack/client.ts`) checks
  the new column first and falls back to treating the URL segment as a
  raw `business_id` — so a shop that connected before this migration,
  with the old URL already pasted into its Paystack dashboard, never has
  to notice anything changed. Getting the resolution wrong in either
  direction only ever produces a 404; it can't route traffic to the wrong
  business, because whatever business_id comes back still has to pass
  that exact business's own signature check before anything is trusted.

  **Audit logging.** `log_audit_event()` (0008) is now granted to
  `service_role`, because the webhook route runs with no authenticated
  user at all — an incoming Paystack event has no person behind it, the
  same reasoning `finalize_sale` already relies on — and it is the one
  caller in this app that needs to write an audit row as `service_role`
  rather than as itself. It now records `paystack_webhook.invalid_signature`
  and `paystack_webhook.duplicate_ignored`, both best-effort (a logging
  failure is swallowed and never turns into a failed webhook response,
  which would just make Paystack retry an event already handled
  correctly). `app/(app)/settings/payments/actions.ts` gained the same
  pattern for the human-driven events: `payment_settings.connected`,
  `.updated`, `.disconnected`, `.webhook_regenerated` — metadata carries
  only booleans (`momo_enabled`, `is_live`, whether the secret changed),
  never the key.

  **Live-mode confirmation.** `paystackSettingsSchema` (`lib/validation/payments.ts`)
  now refuses to save a *new* `sk_live_…` key unless a `confirmLive`
  checkbox came with it — checked only at the moment a live key is being
  entered, not on every later toggle of an already-live, already-confirmed
  account, since that would just become a checkbox people click without
  reading. `paystack-form.tsx` shows the checkbox only once the secret
  field's live-in-progress value actually starts with `sk_live_`, watched
  client-side purely for UI timing; the server makes the identical check
  regardless of what the client thinks.

  6 new SQL security assertions (`tests/security/payments.sql`, sections
  25–27): the identifier is visible to its own owner and regenerable by
  them, invisible to a cashier and to another business's owner, has no
  raw UPDATE path at all, and a service-role audit write correctly
  records no actor. 6 new unit tests (`tests/unit/payments-validation.test.ts`)
  cover the confirmLive branch, including that an unrelated test/live
  key-pair mismatch is still reported on `secretKey`, not `confirmLive`.

- 2026-09-07 — Paystack "Test connection" on the payments settings page.
  Prompted by a full multi-tenant-Paystack specification handed over by
  the user; before writing anything, the existing payment implementation
  was inspected end-to-end (migrations 0022–0025, `lib/paystack/client.ts`,
  `lib/crypto/secret-box.ts`, the webhook route, `tests/security/payments.sql`'s
  172+ assertions) and found to already satisfy nearly everything the
  specification asked for: per-tenant encrypted credentials, HMAC-SHA512
  webhook verification against the *shop's own* key, webhook idempotency,
  the cross-tenant hole closed back in 0023, live/test key-prefix
  validation, and no client-trusted callback (there isn't one — momo is a
  server-initiated charge plus a webhook, not a browser redirect). Rather
  than rebuild any of that, only the one genuinely missing, purely
  additive piece was built, after confirming both the scope and one real
  disagreement with the user: the specification's "inventory must not
  decrease until payment is confirmed" (its §24) directly conflicts with
  this app's deliberate, already-tested "stock leaves the shelf at
  ring-up" design from 0022 (built specifically to stop two tills both
  promising the last unit) — the user chose to keep the existing
  behaviour, so nothing about sale/inventory timing changed here.
  A new module, `lib/paystack/connection-test.ts`, adds `testConnection()`:
  it asks Paystack to verify a transaction reference that cannot exist,
  and reads the difference between a 401 ("Invalid key" — before Paystack
  even looks) and a 404 ("not found" — the key checked out, the reference
  just isn't real) to prove a stored secret actually authenticates,
  without charging anything and without the result ever carrying the key
  itself. It is a separate file from `lib/paystack/client.ts` on purpose:
  client.ts imports the service-role Supabase client, which wraps itself
  in React's `cache()` and only works inside a real Next.js server
  request — pulling that in transitively broke the very first unit test
  written against it (`TypeError: cache is not a function` under Vitest's
  plain Node environment), so `testConnection()` lives somewhere that
  imports nothing from Supabase, only `PaystackCredentials` as a
  type-only (compile-time-erased) import from client.ts. A new Server
  Action (`testPaystackConnection`) gates this behind `business.manage`,
  same as every other read of these settings, and a small client
  component renders a "Test connection" button and result line under the
  existing "Connected" panel — no new table, no schema change, no change
  to the create-sale/webhook/settlement path. 6 new unit tests stub
  `fetch` to cover the 404/401/network-failure/unexpected-status
  branches and confirm the secret key never appears in the returned
  message. The other three additive items the specification raised — a
  webhook identifier separate from the raw `business_id` with a
  regenerate flow, audit-log entries for payment-settings changes, and a
  live-mode confirmation warning — were offered and intentionally deferred
  by the user; they remain open if wanted later.

- 2026-09-07 — Product/service photos, on the catalog pages and the till
  (migration `0046`).
  Requested directly: "i want to be able to add product image to
  product." Two design questions were put to the user before writing
  anything: where a photo should actually render (catalog pages only, or
  also the till grid/search results — chosen: **both**, accepting the
  bandwidth trade-off that entails on the app's single most-loaded
  screen) and whether a product needs one photo or several (chosen:
  **one**, matching the `service_providers` precedent and everything a
  POS catalog actually needs). `photo_url` lives on `products`, not
  `product_variants` — a Size/Color variant of "the same shirt" shares
  one picture, the same way name/description/category already do.
  **Storage** follows `0045`'s already-established shape almost exactly:
  a new PRIVATE bucket, `product-photos` (5 MB cap, `image/jpeg`/`png`/
  `webp` only, enforced at the bucket level and again in the upload
  Server Action), `storage.objects` policies scoped by the path's own
  leading folder segment (`storage.foldername(name)[1]`, always the
  caller's own `business_id`), and `photo_url` storing only the object
  PATH, resolved to a short-lived (1 hour) signed URL at render time via
  `lib/storage/product-photos.ts`. One deliberate departure from `0045`:
  the SELECT policy carries no permission check at all, matching
  `products_select` itself (`0013`) — any active member of the business
  can already see every product's name/price/category regardless of
  role, so gating the photo more tightly would be inconsistent with the
  row it belongs to.
  **Till performance, taken seriously rather than assumed away** — the
  user explicitly chose to put photos on the till knowing the cost, so
  three mitigations went in rather than one: (1)
  `lib/storage/product-photos.ts` signs a whole page of photos in ONE
  Storage call (`createSignedUrls`), not one round trip per row — the
  till can browse a hundred-plus products at once, unlike the small,
  admin-only lists `0045`'s per-row `createSignedUrl` was fine for; (2)
  every rendered thumbnail (`components/ui/product-thumbnail.tsx`) sets
  `loading="lazy"`, so a tile off-screen in the till's scrollable grid is
  never actually fetched; (3) `lib/images/downscale-photo-client.ts`
  downscales/re-encodes a picked photo (to at most 1024px, JPEG quality
  0.82) entirely in the browser, via `<canvas>`, before it ever leaves
  the device — a phone-camera original is routinely 3-8 MB, which is a
  one-time cost to upload but a real, repeated cost once it's something
  the till fetches on every shift. This never blocks a save: any failure
  (unsupported format, browser quirk, an already-small source) falls
  back to the original file untouched, and the server independently
  re-checks size/type before anything touches storage regardless
  (`isAllowedProductPhotoFile`, same shape as `0045`'s own check).
  **The interesting permission question** was whether a brand-new
  product's first photo should need `products.create` (the permission
  that already covers a starting price and opening stock) or
  `products.edit` — and the two are genuinely different in this schema
  (unlike `service_providers`, where a single permission covers create
  and edit alike). `photo_url` joins `enforce_product_field_permissions()`'s
  `products.edit`-gated column list (alongside `category_id`,
  `duration_minutes`, `available_at_till`) for changing an EXISTING
  product's photo — but `create_product()` gained a new `p_photo_url`
  parameter and sets it directly in its own `INSERT`, the same way a
  starting price already bypasses that UPDATE trigger entirely, so
  giving a brand-new product its first photo only ever needs
  `products.create`. That required uploading the photo to Storage
  *before* the product exists (its path can't be keyed by a product id
  that doesn't exist yet) — solved by keying the create-time path with a
  random, throwaway token instead of a real id; `storage.objects`'
  policies never inspect that segment, only the leading `business_id`
  one, so this costs nothing. `create_product()` needed `drop function`
  first (a new parameter is a different overload, not a replacement —
  the same trap every prior parameter addition to this function, `0026`/
  `0040`/`0041`, already documented and guards against). A
  `tests/security/services.sql` addition (section 9) proves both halves
  against real RLS: a role holding `products.archive` but not
  `products.edit` is refused when changing an existing product's photo
  (RLS lets the row through, so the rejection can only be the trigger
  itself — not just the coarse row-level gate), while a role holding only
  `products.create` succeeds at giving a brand-new product its starting
  photo through `create_product()`.
  **New/changed files**: `supabase/migrations/0046_product_photos.sql`
  (`products.photo_url` + storage bucket/policies +
  `enforce_product_field_permissions()`/`create_product()` rewrites);
  `lib/storage/product-photos.ts`; `lib/images/downscale-photo-client.ts`;
  `lib/validation/products.ts` gains `isAllowedProductPhotoFile`;
  `components/ui/product-thumbnail.tsx` (shared by the list, detail, and
  till); `app/(app)/products/product-photo-field.tsx` (shared by the
  create and edit forms); `app/(app)/products/{actions.ts,
  product-form.tsx, product-details-form.tsx, page.tsx, [id]/page.tsx,
  [id]/edit/page.tsx}` — upload/replace/remove actions, and a thumbnail
  on the list row and the detail page's header; `app/(app)/till/{page.tsx,
  till.tsx}` — a thumbnail on every till tile and search result;
  `tests/unit/products-validation.test.ts` gains an
  `isAllowedProductPhotoFile` suite; `tests/security/services.sql` gains
  section 9 (above).

- 2026-09-07 — Service providers: staff who render a service but never
  sign in (migration `0045`).
  Requested directly: "have ability to create staff such as barbers,
  nail tech, .... so we can link exact staff who rendered a particular
  service, we will also have reports on service staff so we track
  individual performances." Migrations `0040`/`0041` already let a
  service line name whoever rendered it — but only from `profiles`, i.e.
  people who can sign in. This adds a second, deliberately separate pool:
  `service_providers`, a simple named record (name, job title/specialty,
  phone, photo, one fixed branch, active/archived) with no `auth.users`
  row and no `profiles` row at all — a real shop chair or booth is
  frequently staffed by someone who has no reason to ever log in to
  Busihub. Three forks were discussed with the user before writing
  anything (recorded in full in `0045`'s own header, summarized here):
  no login (the deliberate, chosen shape — `profiles.id` is a hard FK to
  `auth.users(id)`, so this is genuinely a second table, not a login-less
  profile); tied to exactly one branch, not any branch (`branch_id` is
  `not null` — a service provider only shows up in the till's picker for
  sales at their own branch); and build full photo upload now rather than
  defer it, since nothing in Busihub uploads a file today (confirmed by
  grepping for `avatar_url`/`logo_url` across the app — placeholder text
  columns only) — this is genuinely new infrastructure, not a form field.
  **The hardest design question** was where this plugs into a sale line.
  `sale_items.rendered_by` (a FK to `profiles`, required and validated by
  `create_sale()` for a service line since `0040`) is deliberately left
  completely untouched, rather than repointed or migrated at the new
  table — a historical `rendered_by` profile cannot be safely reassigned
  a single required `service_providers.branch_id` after the fact without
  guessing at history. Instead `sale_items` gains a second, independent
  column, `provider_id` (FK to `service_providers`), alongside the
  original. A service line now carries exactly one of the two — enforced
  inside `create_sale()` itself (the same place `rendered_by`'s own
  requirement has always lived, since the rule depends on the linked
  product's `type`, which a table `CHECK` constraint cannot see); a row-
  local `sale_items_renderer_not_both` constraint adds defense in depth
  against both being set at once, which a `CHECK` constraint CAN see.
  Every sale ever recorded keeps meaning exactly what it always meant.
  `create_sale()` needed no new overload — its signature is unchanged
  (`uuid, uuid, uuid, text, numeric, jsonb, jsonb`), because the per-item
  renderer fields live inside the existing `p_items` jsonb payload, not
  as new positional arguments; a plain `create or replace` sufficed.
  `service_provider_performance()` DID need `drop function` first — its
  `returns table` column list changes (`first_name`/`last_name`, which
  only ever made sense for a `profiles` row, become `renderer_type` +
  `full_name` + `title` so a `service_providers` row has somewhere to put
  its own name and job title) — Postgres refuses a `create or replace`
  that changes a function's return type. The rewritten function unions
  both pools (keyed as `'staff'`/`'provider'` + that pool's own id, never
  comparing a `profiles.id` and a `service_providers.id` as if they were
  one id space) into one leaderboard, still `security invoker`, still
  attributing each service LINE's own revenue to whoever actually
  rendered it rather than composing from `staff_performance()` (same
  reasoning `0041`'s version already gave for why that composition would
  silently answer the wrong question).
  **Permissions** — reusing `users.manage` (create/edit/archive) and
  `sales.process OR users.manage` (view), no new permission key, so
  nothing needs backfilling onto any already-registered business's roles
  (the same standing rule `0040`/`0041` already established for
  services/categories). This is a staffing decision, not a catalog one,
  so — unlike categories — it does not reuse `products.*`.
  **Photo storage** — a new PRIVATE Supabase Storage bucket,
  `service-provider-photos` (5 MB cap, `image/jpeg`/`png`/`webp` only,
  enforced at the bucket level and again in the upload Server Action).
  Deliberately private, not public: a public bucket would mean anyone
  holding a photo's URL could load it forever with no permission check —
  exactly the "access by knowing an id/URL" pattern the master spec rules
  out, even though a uuid-shaped path is not realistically guessable.
  `storage.objects` policies scope every read/write/delete by the path's
  own leading folder segment (always the caller's own `business_id`,
  never taken from the client) via `storage.foldername(name)[1]`, checked
  against the same `sales.process`/`users.manage` permissions the table
  itself uses. `service_providers.photo_url` stores only the object PATH,
  never a public URL; `lib/storage/service-provider-photos.ts` resolves
  it to a short-lived (1 hour) SIGNED url at render time, so a stale
  cached link goes dead on its own rather than staying live forever.
  **New/changed files**: `supabase/migrations/0045_service_providers.sql`
  (table + RLS + storage bucket/policies + `sale_items.provider_id` +
  `create_sale()`/`service_provider_performance()` rewrites);
  `lib/validation/service-providers.ts` +
  `tests/unit/service-providers.test.ts`;
  `lib/storage/service-provider-photos.ts`;
  `app/(app)/settings/service-providers/{page.tsx, actions.ts,
  provider-form.tsx, new/page.tsx, [id]/edit/page.tsx}` — modelled
  directly on `products/categories`' own list/new/edit/actions shape,
  and deliberately kept to the plain `<h1>`/`rounded-2xl border` header
  style every other Settings page still uses (the `PageHeader`/`Card`
  design-system rollout in phases 1-9 was scoped to Products, Customers,
  Sales, and Inventory only — introducing it in one corner of Settings
  alone would read as inconsistent, not as progress); `nav-items.tsx`
  gains a "Service Providers" leaf under Settings (gated by the existing
  `canManageUsers`, not a new nav permission) — the actual place a new
  Settings-area destination is registered in this app, confirmed by
  checking how Products → Categories is wired in (a sidebar entry, not an
  inline link on the Products page, which has none).
  `lib/validation/sales.ts`'s `cartLineSchema` replaces its single
  `renderedBy` field with `renderedByStaffId`/`renderedByProviderId` (plus
  a `.refine()` rejecting both at once, mirroring the database's own
  constraint) — `checkoutSchema`'s duplicate-line dedup key now includes
  both. `app/(app)/till/actions.ts`'s `completeSale()` sends whichever one
  the till chose straight through to `create_sale()`. `app/(app)/till/
  page.tsx` now also queries `service_providers` scoped to the sale's own
  active branch (staff, by contrast, has always been business-wide) and
  passes it to `till.tsx` as a new `providers` prop. `till.tsx` merges
  both pools into one "who rendered this?" picker, encoding each option
  as `staff:<id>` or `provider:<id>` (`encodeRenderer`/`decodeRenderer`)
  so the two id spaces are never compared as if they were one, and decodes
  the choice back into the two named fields the hidden `cartJson` payload
  now carries. `app/(app)/sales/[id]/page.tsx`'s "Rendered by" line now
  falls back from the `rendered_by` embed to a new `provider` embed
  (`service_providers(name, title)` — sale_items has only one FK to that
  table, same unambiguous-embed reasoning already used for `rendered_by`
  itself). `app/(app)/reports/sales/page.tsx`'s "Who rendered what"
  section consumes `service_provider_performance()`'s new unified shape
  (`renderer_type`, `renderer_id`, `full_name`, `title`) instead of the
  old `provider_id`/`first_name`/`last_name`.
  Every new/modified `.ts`/`.tsx` file passed the sandbox's `tsc
  --noEmit` structural syntax check (filtered to genuine `TS1xxx`
  parse/syntax errors only) — I have not run `npm run typecheck` / `npm
  run lint` / `npm test` / `npm run build` myself, since this sandbox has
  no npm registry access. Please run those and paste back anything that
  fails, same as always. This migration also needs to actually run
  against the Supabase project (`npm run db:migrate` or equivalent) —
  unlike the UI-polish phases above, this one is not a no-op on the
  database.

- 2026-09-07 — UI/UX polish pass, phase 9 of N (Inventory — stock
  history, receive, adjust, and count pages).
  Continuing the phased redesign (phases 1-8 above/below): this is the
  fourth and final phase of the "detail/edit/new pages" sub-sequence
  across Products, Customers, Sales, and Inventory, completing the scope
  approved after phase 5. Same rule as every phase touching a
  data-heavy screen: presentation only. Every Supabase query (the
  variant/stock-levels/movements lookups on the stock-history page, the
  shared `loadStockFormData` call behind all three stock-entry pages),
  every permission check (`INVENTORY_VIEW`, `INVENTORY_RECEIVE`,
  `INVENTORY_ADJUST`), every redirect/notFound call, every calculation
  (the per-branch and total-across-branches quantities, the movement
  delta sign and color, the "currently on hand" figure the form reads
  per selected variant), and every bound server action (`adjustStock`,
  `recordStockCount`, `receiveStock`) is untouched, character for
  character — confirmed by reviewing the complete final files against
  the originals.
  What changed, concretely: `inventory/adjust/page.tsx`,
  `inventory/count/page.tsx`, and `inventory/receive/page.tsx`'s
  identical plain `<h1>` + one-line description headers now use the
  shared `PageHeader`. `inventory/[variantId]/page.tsx` (the per-variant
  stock-history page) also moved to `PageHeader` — unlike the Products/
  Customers/Sales detail pages in phases 6-8, its header has no status
  badges next to the title, just a title, a one-line description, and
  the Receive/Adjust action buttons, which is exactly `PageHeader`'s
  contract. That page's "On hand" and "Movement history" boxes — two
  more hand-rolled `rounded-2xl border bg-white` boxes — became `Card`s,
  and the movement-history table's rows gained `transition-colors` on
  hover (matching every other data table redesigned in phases 5-8).
  `stock-form.tsx`'s "no active products to stock yet" early return —
  previously one sentence with an inline link, replacing the whole form
  exactly like the empty-full-form cases `EmptyState` was built for in
  phases 5 and 8 — became `EmptyState` (icon `PackagePlus`), with the
  same "Add a product" link now rendered as its `action` button instead
  of sitting mid-sentence; same condition (`variants.length === 0`),
  same destination (`/products/new`), just a different presentational
  shape for the identical link — flagged here since it is a slightly
  larger visual change than a straight pill or box swap.
  Left deliberately alone: the "No stock recorded yet." and "No
  movements recorded yet." rows inside the On-hand list and the
  Movement-history table stay plain text — same reasoning as every
  small in-page empty row left alone in phases 5, 7, and 8 (Inventory's
  own list-page table in phase 5, Customers' account history in phase
  7, Sales' items/payments tables in phase 8): `EmptyState`'s icon-
  circle treatment is for a genuinely empty full page or full form, not
  a sub-section of a page that already has other content. The stock
  form's "Branch: … change" strip stays a plain `bg-neutral-100` notice
  for the same reason `account-entry-form.tsx`'s balance label
  (phase 7) and `refund-form.tsx`'s "Roughly" estimate (phase 8) stayed
  plain notices rather than becoming `Card`s.
  This completes the "detail/edit/new pages for these four areas" scope
  approved after phase 5 (Products in phase 6, Customers in phase 7,
  Sales in phase 8, Inventory here).
  No database, permission, or RLS surface changed, and no page's actual
  numbers, visibility rules, or links changed — so no migration and no
  security test changes.

- 2026-09-07 — UI/UX polish pass, phase 8 of N (Sales — detail, receipt,
  and refund pages).
  Continuing the phased redesign (phases 1-7 above/below), and the third
  of the "detail/edit/new pages" sub-sequence across Products, Customers,
  Sales, and Inventory: this phase is Sales' half (Inventory follows as
  the final phase). Same rule as every phase touching a data-heavy
  screen: presentation only. Every Supabase query (the sale/items/
  payments/refunds lookups on the detail page, the sale-plus-business-
  plus-settings lookups that build the receipt text, the sale-items/
  already-refunded lookups on the return page), every permission check
  (`SALES_PROCESS`, `REPORTS_VIEW`, `SALES_VOID`, `SALES_REFUND`), every
  redirect/notFound call, every calculation (the refunded-total sum, the
  net-after-returns figure, the per-unit refund basis derived from the
  original line rather than the catalog, the refund preview total, the
  receipt's `ReceiptData` assembly and its width-from-paper-size lookup),
  and every bound server action (`voidSale`, `refundSale`,
  `checkSalePayment`, `cancelSale`) is untouched, character for
  character — confirmed by reviewing the complete final files against
  the originals.
  What changed, concretely: `sales/[id]/receipt/page.tsx` and
  `sales/[id]/refund/page.tsx`'s plain `<h1>` + one-line description
  headers now use the shared `PageHeader` (the receipt page's header
  keeps its `print:hidden` class via `PageHeader`'s `className` prop, so
  what actually comes out of the printer is unchanged).
  `sales/[id]/page.tsx` (the sale detail page) keeps its existing custom
  header layout rather than being forced into `PageHeader` — same
  reasoning as `products/[id]/page.tsx` and `customers/[id]/page.tsx` in
  phases 6 and 7: up to four status pills sit inline next to the title
  alongside a separate date/branch/cashier line, a shape `PageHeader`'s
  contract doesn't fit — but all four hand-rolled pills (the payment-
  method tag, and the Voided/Waiting-for-payment/Cancelled status pills)
  became the shared `Badge`. The Cancelled pill's neutral shade
  normalizes slightly in the process (`bg-neutral-200` -> Badge's
  `bg-neutral-100`), the same kind of disclosed one-shade normalization
  made to Sales' list-page pills in phase 5. That page's items table,
  its "How it was paid" box, and its "Returns against this sale" box —
  three more hand-rolled `rounded-2xl border bg-white` boxes — became
  `Card`s, and the items table's rows gained `transition-colors` on
  hover (they had none before, matching every other data table
  redesigned so far). `refund-form.tsx`'s items table got the same
  `Card` and row-hover treatment, and its "everything already returned"
  early-return message — previously a plain bordered sentence that
  replaces the whole form, exactly the "genuinely empty full page" case
  phase 5 built `EmptyState` for — became `EmptyState` (icon
  `PackageCheck`).
  Left deliberately alone: the receipt page's printed slip box
  (`receipt-sheet`) keeps its own hand-rolled classes rather than
  becoming `Card` — `Card` adds a `dark:bg-neutral-900` background that
  would tint the printed-paper look dark in dark mode, which is not a
  presentation-only swap for a component whose whole job is to look like
  a physical receipt regardless of the app's theme. `receipt-controls.tsx`
  was read and left untouched — it already uses `Button` and has nothing
  hand-rolled to fix. `awaiting-payment.tsx`'s two colored notice boxes
  (amber "waiting", red "declined") were read and left untouched — they
  are meaningful semantic alerts with their own amber/red border-and-
  background treatment, not generic list/card containers, the same
  reasoning that already kept the sale detail page's voided/cancelled
  notices as plain colored paragraphs rather than `Card`s.
  `refund-form.tsx`'s "Roughly {amount}" strip stays a plain
  `bg-neutral-100` notice for the same reason `account-entry-form.tsx`'s
  balance label stayed one in phase 7 — an informational strip, not a
  list/card container. `status-toggle-button.tsx` is untouched for the
  same nine-call-site reasoning given in phase 6.
  No database, permission, or RLS surface changed, and no page's actual
  numbers, visibility rules, or links changed — so no migration and no
  security test changes.

- 2026-09-07 — UI/UX polish pass, phase 7 of N (Customers — detail,
  edit, new, charge, and payment pages).
  Continuing the phased redesign (phases 1-6 above/below), and the
  second of the "detail/edit/new pages" sub-sequence across Products,
  Customers, Sales, and Inventory: this phase is Customers' half (Sales
  and Inventory follow as later phases). Same rule as every phase
  touching a data-heavy screen: presentation only. Every Supabase query
  (the customer/balance/account-entries lookups on the detail page, the
  customer-plus-balance-plus-branches lookups on the charge and payment
  pages), every permission check (`CUSTOMERS_VIEW`, `CUSTOMERS_EDIT`),
  every `redirect`/`notFound` call, every calculation (the balance/
  credit-limit/headroom figures and their owing/in-credit color
  thresholds, the "settled up" / "currently owed" balance label built
  for the charge and payment forms, the decimal-string coercions), and
  every bound server action (`setCustomerStatus`, `updateCustomer`,
  `recordCharge`, `recordPayment`, `createCustomer`) is untouched,
  character for character — confirmed by reviewing the complete final
  files against the originals.
  What changed, concretely: four pages whose header was a plain
  `<h1>` + one-line description (`customers/[id]/edit`,
  `customers/[id]/charge`, `customers/[id]/payment`, `customers/new`)
  now use the shared `PageHeader`. `customers/[id]/page.tsx` (the
  customer detail page) keeps its existing custom header layout rather
  than being forced into `PageHeader` — same reasoning as
  `products/[id]/page.tsx` in phase 6: it has a status badge inline next
  to the title alongside a separate phone-number line, a shape
  `PageHeader`'s single-title/single-description contract doesn't
  cleanly fit — but its one hand-rolled "Archived" pill became the
  shared `Badge`. That page's three balance/credit-limit/headroom
  summary boxes, its email/address/notes details box, and its account-
  history table's outer box — all three previously hand-rolled
  `rounded-2xl border bg-white` boxes, identical in every way to what
  `Card` already provides — became `Card`s, and each account-history
  row gained `transition-colors` on hover (it had none before, matching
  the same fix made to Inventory's table in phase 5 and Products'
  variant table in phase 6).
  Left deliberately alone: the account-history table's empty-row
  message ("Nothing on this account yet.") stays a plain centered table
  row (`<tr><td colSpan>`) rather than `EmptyState`, which doesn't fit
  inside a table row's markup — same reasoning as Inventory's table in
  phase 5. `customer-form.tsx` and `account-entry-form.tsx` were read
  and left untouched — both already use `Field`/`Select`/`Textarea`/
  `SubmitButton` and already have `role="alert"` on their error banners,
  so they were already consistent with the rest of the design system;
  `account-entry-form.tsx`'s balance-label strip is a plain informational
  notice rather than a list/card container, so it wasn't a fit for
  `Card` either. `status-toggle-button.tsx` is untouched for the same
  nine-call-site reasoning given in phase 6.
  No database, permission, or RLS surface changed, and no page's actual
  numbers, visibility rules, or links changed — so no migration and no
  security test changes.

- 2026-09-07 — UI/UX polish pass, phase 6 of N (Products — detail,
  edit, new, and variant/category sub-pages).
  Continuing the phased redesign (phases 1-5 above/below), and the first
  of a sub-sequence covering "detail/edit/new pages" across Products,
  Customers, Sales, and Inventory: this phase is Products' half of that
  scope (Customers, Sales, and Inventory follow as later phases). Same
  rule as every phase touching a data-heavy screen: presentation only.
  Every Supabase query (the product/variant/stock-level lookups on the
  detail page, the category/product-with-embedded-category lookups on
  the edit and new pages), every permission check (`PRODUCTS_EDIT`,
  `PRODUCTS_ARCHIVE`, `PRODUCTS_CHANGE_PRICE`, `PRODUCTS_CREATE`,
  `INVENTORY_VIEW`, `INVENTORY_RECEIVE`), every `redirect`/`notFound`
  call, every calculation (stock-by-variant aggregation, the SKU sort
  that pushes variant-less rows last, `formatMoneyMinor`'s
  decimal-string coercion), and every bound server action
  (`setProductStatus`, `setProductTillAvailability`, `setVariantStatus`,
  `setCategoryStatus`, `updateProductDetails`, `createProduct`,
  `addVariant`, `updateVariant`, `createCategory`, `updateCategory`) is
  untouched, character for character — confirmed by reviewing the
  complete final files against the originals.
  What changed, concretely: six pages whose header was a plain
  `<h1>` + one-line description (`products/[id]/edit`,
  `products/[id]/variants/new`, `products/[id]/variants/[variantId]/edit`,
  `products/new`, `products/categories/new`,
  `products/categories/[id]/edit`) now use the shared `PageHeader`.
  `products/[id]/page.tsx` (the product detail page) keeps its existing
  custom header layout rather than being forced into `PageHeader` — it
  has inline status badges next to the title plus a separate
  conditionally-rendered description paragraph, a shape `PageHeader`'s
  single-title/single-description contract doesn't cleanly fit — but its
  three hand-rolled pills (Service/Archived/Hidden-from-till) became the
  shared `Badge`, its variant table's outer box became `Card`, each
  variant row gained `transition-colors` on hover (it had none before,
  matching the same fix made to Inventory's table in phase 5), and the
  per-variant Active/Archived status pill became `Badge` as well —
  Active's shade normalizes a step lighter in the process (`bg-green-100`
  -> Badge's `bg-green-50`), the same disclosed normalization phase 5
  made to Sales' status pills. `products/categories/page.tsx` received
  the fuller treatment already given to the four phase-5 list pages: its
  ad-hoc header became `PageHeader`, its Active/Archived tabs gained
  `transition-colors`, its error banner gained an `AlertCircle` icon and
  explicit `role="alert"`, its empty state (no categories yet /
  no archived categories) became the shared `EmptyState` (icon
  `FolderOpen`) with the exact same per-tab copy the original had, its
  list container became `Card`, and its "Starter" (`is_system`) pill
  became `Badge`. Inside `product-form.tsx` (the client-side create-
  product form), the "Product"/"Service" toggle buttons gained
  `transition-colors`, matching every other segmented control redesigned
  so far, and each dynamic variant row — previously a hand-rolled
  `rounded-xl border` div — became `Card`.
  Left deliberately alone: `status-toggle-button.tsx` — its own header
  comment discloses nine app-wide call sites (sales, staff, admin
  businesses, suppliers, purchase orders, awaiting-payment, payment
  settings, customers, products/services) and it already composes the
  shared `SubmitButton`/`Button`/`ConfirmDialog`, so there was nothing to
  fix and real risk in touching something that widely shared for zero
  visible benefit. `category-form.tsx`, `variant-form.tsx`, and
  `product-details-form.tsx` were read and left untouched — all three
  already use `Field`/`Select`/`Textarea`/`SubmitButton` (plus
  `CategoryCombobox`/`BarcodeScannerModal` where relevant) and already
  have `role="alert"` on their error banners, so they were already
  consistent with the rest of the design system.
  No database, permission, or RLS surface changed, and no page's actual
  numbers, visibility rules, or links changed — so no migration and no
  security test changes.

- 2026-09-07 — UI/UX polish pass, phase 5 of N (Products, Customers,
  Sales, and Inventory — the core list pages).
  Continuing the phased redesign (phases 1-4 above/below): this phase
  covers the four highest-traffic list pages after the till and
  dashboard. Same rule as every phase touching a data-heavy screen:
  presentation only. Every Supabase query and its filters (name/category/
  type/price search on Products, name/phone search and the owing filter
  on Customers, status/date-range/receipt-number search and pagination on
  Sales, per-branch stock lookups on Inventory), every permission check
  (`PRODUCTS_CREATE`, `CUSTOMERS_VIEW`/`CUSTOMERS_EDIT`, `SALES_PROCESS`/
  `REPORTS_VIEW`, `INVENTORY_VIEW`/`INVENTORY_RECEIVE`/`INVENTORY_ADJUST`),
  every redirect, and every calculation (price ranges, customer balances
  and the "total owed" figure, the sales summary RPC totals, stock
  quantities) is untouched, character for character — confirmed by
  reviewing the complete final files against the originals. All four
  pages' `loading.tsx` already used the shared `SkeletonBlock`/
  `SkeletonPage` components from an earlier pass, so none of those needed
  any change.
  What changed, concretely, on all four: the ad-hoc `<h1>` + description +
  action-button header became a `PageHeader`. The segmented filter tabs
  (status/type/branch/owing) gained `transition-colors`. The "couldn't
  load" error banner gained an `AlertCircle` icon and an explicit
  `role="alert"` (Products, Customers, and Inventory's banner didn't have
  one; the till and dashboard's already did). The list container (a
  hand-rolled `rounded-2xl border bg-white` box on all four) became the
  shared `Card`, and each list row's hover state gained `transition-colors`
  (Inventory's table rows didn't have a hover state at all before this —
  they do now, matching the dashboard's staff/branch tables from phase 3).
  Products and Sales' small colored status pills — service/archived/
  variant-count/hidden-from-till on Products, completed/waiting/voided/
  cancelled on Sales — became the shared `Badge` component. Sales'
  chip colors normalize a shade lighter in the process (e.g. completed's
  `bg-green-100` -> Badge's `bg-green-50`) to match the one token set the
  rest of the app already uses instead of keeping a second, slightly
  darker green/amber/red/grey that existed only on that page — flagged
  here rather than left for someone to notice on their own.
  Products, Customers, and Sales' empty-list messages (a plain sentence,
  sometimes with a button) became the shared `EmptyState` component added
  in phase 1 but not yet wired into any page — its own header comment
  flagged that as a page-by-page follow-up, and these three genuinely-
  empty full-page lists are exactly the case it was built for (unlike the
  dashboard's small inline panels in phase 3, which stayed plain sentences
  because `EmptyState`'s icon-circle-plus-padding treatment would look
  oversized there). Each keeps the exact same condition and copy the
  original branch had (archived/filtered/no-results text, and the same
  "Add Product"/"Add Service"/"Add customer" button gated behind the same
  `canCreate`/`canEdit` check) — only the presentation wrapper changed.
  The Sales KPI strip (Sales/Takings/Returned/Net) — four hand-rolled
  `rounded-2xl border bg-white p-4` boxes, identical in every way to what
  `Card` already provides — became `Card`s.
  Left deliberately alone: Inventory's empty-table message stays a plain
  centered table row (`<tr><td colSpan>`) rather than `EmptyState`, which
  doesn't fit inside a table row's markup — same reasoning as leaving the
  dashboard's tables alone in phase 3. None of the four pages' native
  filter `<input>`/`<select>` elements were swapped for the `Field`/
  `Select` client components — those are controlled inputs built for
  client-side state, and these are plain GET-form filters whose values
  live in the URL; forcing that onto a client component would be a real
  behavior change, not a presentation one, so they keep their existing
  (already-consistent) input styling instead.
  No database, permission, or RLS surface changed, and no page's actual
  numbers, visibility rules, or links changed — so no migration and no
  security test changes.

- 2026-09-07 — UI/UX polish pass, phase 4 of N (the till/POS screen).
  Continuing the phased redesign (phases 1-3 above/below): this is the
  app's single highest-traffic screen, reloaded after every sale, so the
  same strict rule as the dashboard phase applied — presentation only.
  Every calculation (`total`, cash `change`, the split-payment `momoPart`
  preview, `shortLines`, `missingRenderedBy`), every call into
  `actions.ts` (`completeSale`, `signOutCashier`, `openDrawerNoSale`), the
  cart's client-only line identity (`crypto.randomUUID()`), the
  barcode/SKU exact-match logic shared by the USB scanner and the camera
  modal, and every permission-derived prop (`canOpenDrawer`,
  `allowNegativeStock`, `momoEnabled`) is untouched, character for
  character — confirmed by reviewing the complete final files against the
  originals rather than assuming.
  `app/(app)/till/till.tsx` — the ad-hoc `<h1>Till</h1>` + branch/cashier
  line + action buttons became a `PageHeader` (from phase 1; its
  `description` prop was widened from `string` to `React.ReactNode` so
  the cashier's name could stay bold within the sentence — a
  backward-compatible widening, every existing caller still passes a
  plain string). The product search results, the browsable product grid,
  and the cart line list — three separately hand-rolled
  `rounded-2xl border bg-white` boxes — became the shared `Card`. The
  cart's quantity `−`/`+` text-character buttons became lucide
  `Minus`/`Plus` icons with explicit `aria-label`s, and the payment total
  box became a `Card`. The error banner gained an `AlertCircle` icon.
  The "No sale" (open cash drawer without a sale) dialog — previously its
  own bespoke `fixed inset-0` overlay, the last one of those left in the
  app — was migrated onto the shared `Modal` shell added in phase 1
  (`components/ui/modal.tsx` had explicitly flagged this exact dialog as
  a deferred follow-up). Both of its states (the confirm step, then the
  printable slip) render as the same `Modal` with a different
  title/description/footer; the `pending` prop is set to
  `noSalePending || Boolean(noSaleSlip)` so backdrop-click, Escape, and
  the modal's close button stay disabled under the exact same two
  conditions the original hand-rolled `onClick` guard checked (never
  while the drawer-open request is in flight, and never once the slip is
  showing — that still requires clicking "Close" on purpose). The modal
  is wrapped in its own `print:hidden` div, since `Modal` itself has no
  opinion about printing — the separate `hidden print:block` slip
  rendering right after it, which is what a print job actually sends to
  the printer, is unchanged. Net gain from the migration: focus-on-open
  and Escape-to-close, neither of which the original had.
  `app/(app)/till/pin-pad.tsx` — the till's lock screen (PIN entry,
  "you don't have a PIN yet", switch-user picker, switch-user password
  entry) gained a small icon circle above each screen's heading
  (`KeyRound`/`Users`/`Lock`, matching the avatar-circle treatment
  app-shell.tsx already uses), and its colleague-picker list and
  no-PIN-yet notice became the shared `Card` (the no-PIN-yet box
  previously had no explicit background, an inconsistency with every
  other bordered box in this file — `Card` fixes that as a byproduct).
  The backspace key's `←` text character became a lucide `Delete` icon
  with an `aria-label` — the only other leftover hand-rolled arrow
  character in the app after phase 3 removed the dashboard's. No changes
  to PIN verification, the lockout timer, or the switch-user password
  flow.
  Left deliberately alone: `app/(app)/till/loading.tsx` already used the
  shared `SkeletonBlock`/`SkeletonPage` components from an earlier pass,
  so nothing needed changing there. `BarcodeScannerModal` (the
  phone-camera scanner) keeps its own bespoke overlay — it owns a live
  `<video>` element and its own camera-permission error states that don't
  fit the generic `Modal` shell's content model, the same reasoning
  `Modal`'s own header comment already gave for leaving it alone.
  No database, permission, or RLS surface changed, and no calculation,
  visibility rule, or server call changed — so no migration and no
  security test changes.

- 2026-09-07 — UI/UX polish pass, phase 3 of N (the dashboard).
  Continuing the phased redesign (phases 1-2 below): this phase applies
  the phase-1 foundation components to `app/(app)/dashboard/page.tsx`,
  `sales-chart.tsx`, and `loading.tsx`. This file is entirely
  presentation-layer work — every permission check
  (`canSeeMoney`/`canViewInventory`/etc.), every RPC call
  (`sales_summary`, `sales_trend`, `dashboard_snapshot`,
  `low_stock_report`, `staff_performance`, `branch_performance`,
  `expense_summary`, `expenses_by_category`), every calculation (net
  profit, average sale, urgent-stock count), and every conditional that
  decides what a given permission level sees is untouched, character for
  character — confirmed by reviewing the full diff against the original
  file rather than assuming. The one non-presentational touch: the file's
  own local `Card` component (a `<section>` wrapper duplicating what
  `components/ui/card.tsx` now provides) and local severity-badge pill
  classes were removed in favor of the shared components; the local
  `SEVERITY_STYLES` color mapping became `SEVERITY_BADGE` mapped to
  `Badge` variants with the exact same colors (out=red, critical=amber,
  low=neutral-grey) it already used.
  What changed, concretely: the ad-hoc `<h1>` + date/branch line + action
  buttons became a `PageHeader` (from phase 1). The four KPI tiles (Net
  sales, Gross profit, Net profit/Average sale, Returned) gained an icon
  each (`Wallet`, `TrendingUp`, `PiggyBank`/`Receipt`, `Undo2`), a
  `hoverable` `Card`, and a larger value (`text-xl` -> `text-2xl`) for
  the "large readable values" the request asked for. The low-stock
  severity pill became the shared `Badge`. The "awaiting payment" and
  "stock running out" priority banners gained a `Clock`/`AlertTriangle`
  icon each, and every plain "→" text arrow in the file became a lucide
  `ArrowRight`. The two data tables (staff performance, branch
  performance) gained row hover states. `sales-chart.tsx` — a
  deliberately server-rendered plain-SVG chart with NO client JavaScript
  and NO charting library, kept that way on purpose for a shop on a phone
  on mobile data (see that file's own header comment) — gained a pure-CSS
  `animate-fade-in` entrance (from phase 1's `tailwind.config.ts`), which
  plays automatically on first paint with zero added JavaScript, so that
  architectural choice is unaffected. `dashboard/loading.tsx`'s local
  `Block` skeleton component (identical to the pre-existing
  `SkeletonBlock` in `components/ui/skeleton.tsx`) was replaced by that
  shared component instead of keeping a duplicate.
  Left deliberately alone: the small inline empty-state sentences
  ("Nothing taken today.", "Everything is above its reorder point.", …)
  were NOT converted to the new `EmptyState` component — that component's
  icon-circle-plus-padding treatment is sized for an empty full-page list,
  and would look oversized inside these already-compact dashboard panels;
  a plain contextual sentence reads better at this size. The two data
  tables were not restructured into a mobile card layout — both already
  degrade via a contained `overflow-x-auto` scroll that doesn't affect
  page width, a reasonable existing pattern for a 4-5 column table.
  No database, permission, or RLS surface changed, and no page's actual
  numbers, visibility rules, or links changed — so no migration and no
  security test changes.

- 2026-09-07 — UI/UX polish pass, phase 2 of N (navigation and header).
  Continuing the phased redesign from phase 1 (below): this phase polishes
  the existing app chrome — sidebar, mobile drawer, top header,
  notification bell — rather than replacing any of it, since all of it
  was already structurally sound (a real permission-aware nav tree, a
  working mobile drawer with backdrop, a sticky desktop sidebar). No
  layout architecture changed: same breakpoint (`md:`) switches between
  drawer and in-flow sidebar, same 256px desktop width. A collapsible
  icon-only sidebar was mentioned as optional in the original ask and is
  deliberately deferred — it's a real feature (persisted state, tooltips
  for icon-only labels, a resize of the main content area) better done as
  its own reviewed change than folded into a polish pass; happy to build
  it if wanted.
  `components/layout/sidebar.tsx` — every interactive nav element (leaf
  links, group toggle buttons, child links, the mobile close button) now
  has an explicit `focus-visible` ring matching `components/ui/button.tsx`'s
  own treatment; before this the sidebar relied entirely on the browser's
  default outline, which is inconsistent across browsers and wasn't
  present anywhere else in this file. The mobile backdrop now fades in
  (`animate-fade-in`, from phase 1) instead of appearing instantly. The
  "B" logo badge is a touch larger with a subtle shadow.
  `components/notifications/notification-bell.tsx` — the bell icon was a
  hand-drawn inline SVG, the one place in the app not using the
  `lucide-react` icon set every nav item and other component already
  uses; swapped for lucide's own `Bell` icon, visually equivalent but now
  actually the same icon system as everywhere else. Its dropdown panel's
  "Loading…" text became a 3-row skeleton (reusing `SkeletonBlock` from
  the existing `components/ui/skeleton.tsx`) and the panel now slides
  down on open (`animate-slide-down`, from phase 1) instead of appearing
  instantly. Added the same explicit focus rings as the sidebar to the
  bell button, "Mark all as read", and each notification link. None of
  its data-fetching, polling, or optimistic-update logic changed at all —
  presentation only.
  `components/layout/app-shell.tsx` — the header gained a subtle shadow,
  a thin divider between the notification bell and the user area, and a
  small initials avatar (e.g. "Jane Doe" -> "JD", computed from the
  existing `userLabel` prop — no new prop needed) next to the user's
  name, giving it an actual "profile area" rather than a bare name string.
  The mobile menu button gained the same explicit focus ring as
  everything else touched in this phase. Header height/padding is
  unchanged on purpose — `notification-bell.tsx`'s mobile panel position
  is hand-tuned against that exact height (see its own comment), and
  changing it here would have silently broken that.
  No page content, no route, no permission, and no data-fetching logic
  changed anywhere in this phase — every diff is presentational or an
  accessibility addition (explicit focus rings) to components that
  already existed. No database or RLS surface, so no migration and no
  security test changes.

- 2026-09-07 — UI/UX polish pass, phase 1 of N (foundation components).
  The ask was a full professional redesign of the whole POS interface —
  design system, dashboard, navigation, buttons, loading states,
  animations, cards, tables, forms, modals, toasts, responsiveness, the
  till screen, empty/error states, accessibility, micro-interactions,
  covering essentially every page. Given the size of that (30+ routes)
  and that every change here ships as a script that's run and verified on
  the real project rather than applied directly, this is being done in
  verified phases rather than one pass — phase 1 is the shared building
  blocks every later phase reuses, so page-by-page work never has to be
  redone once a better primitive shows up.
  An inspection first (nothing rebuilt sight unseen): the app already had
  a real, consistent design system — Tailwind with a custom `brand` color
  scale, the neutral/dark-mode palette, `lucide-react` for every icon
  (already covering every nav item), `rounded-xl`/`rounded-2xl`,
  consistent focus rings, and existing shared components (`Button`,
  `SubmitButton`, `Field`, `Select`, `Checkbox`, `Textarea`,
  `SkeletonBlock`/`SkeletonPage`, `ConfirmDialog`). What genuinely didn't
  exist yet: a toast/notification system (errors only ever showed as
  inline red boxes), a generic modal (`ConfirmDialog` only covers yes/no
  confirmations), `Card`/`Badge`/`EmptyState`/`PageHeader`, and a
  button loading state with an actual spinner rather than text alone.
  This phase adds exactly those gaps:
  `components/ui/spinner.tsx` (new) — a single reusable spinner (CSS
  `animate-spin`, no library) every loading state below uses.
  `components/ui/button.tsx` — `Button` gained an optional `loading` prop
  (renders the spinner, disables the button, sets `aria-busy`) and a
  subtle `active:scale-[0.98]` press effect (skipped under
  `prefers-reduced-motion` via Tailwind's `motion-reduce:` variant).
  `SubmitButton` now passes `loading={pending}` through, so every existing
  `<SubmitButton pendingText="Saving…">` call across the app — unchanged
  itself — now shows "[spinner] Saving…" instead of text alone, and stays
  exactly as disabled (so exactly as protected against a double-submit)
  as it already was.
  `components/ui/card.tsx` (new) — `Card`/`CardHeader`/`CardTitle`/
  `CardDescription`/`CardContent`/`CardFooter`, one consistent card shell
  (border, radius, background, dark mode) with an optional `hoverable`
  prop for cards that are themselves clickable.
  `components/ui/badge.tsx` (new) — status pills (`neutral`/`brand`/
  `success`/`warning`/`danger`/`info`), reusing Tailwind's stock
  green/amber/red/blue scales rather than inventing new semantic color
  tokens (this app's "danger" already means `red-600` everywhere else).
  `components/ui/empty-state.tsx` (new) — icon + title + description +
  action, for list pages that currently show a bare sentence or nothing.
  `components/ui/page-header.tsx` (new) — title + description + an
  actions slot, stacking on narrow screens instead of forcing horizontal
  scroll with a wide button row next to a page title.
  `components/ui/modal.tsx` (new) — the general-purpose modal
  `ConfirmDialog` never was; built the same unopinionated way (no portal,
  no focus-trap library) so it matches that proven pattern rather than
  introducing a second one. Behaves as a bottom sheet on mobile (slides up
  from the bottom, rounded top corners only) and a centered dialog at
  `sm:` and up.
  `components/ui/toast.tsx` (new) — `ToastProvider` + `useToast()`,
  mounted once in `app/layout.tsx` around `{children}` so any client
  component anywhere can call `useToast().success(...)` /
  `.error(...)` / `.info(...)`. Auto-dismisses after 5s, individually
  closeable, announced via `aria-live`. Deliberately additive alongside
  existing inline `useFormState` field errors, not a replacement for them.
  `tailwind.config.ts` — three shared entrance animations (`fade-in`,
  `slide-up`, `slide-down`), each 150-200ms, used by the new modal and
  toast.
  `app/globals.css` — a `prefers-reduced-motion: reduce` rule that
  shortens every animation/transition in the app to near-zero, as a
  blanket second layer under the per-element `motion-reduce:` variants
  used at individual call sites.
  Existing bespoke modals (`BarcodeScannerModal`, till.tsx's No-Sale
  dialog) and every page's current empty/error text are deliberately left
  untouched in this phase — migrating them onto these new primitives, and
  the dashboard/navigation/till/other-page redesigns themselves, are
  later phases. No database, permission, RLS, or route surface changed —
  this phase is entirely new/extended presentation-layer components plus
  one call-site change (`SubmitButton`'s internal `disabled` prop became
  `loading`, same resulting behavior) — so no migration and no security
  test changes.

- 2026-09-07 — "works but takes long for camera to scan bar codes,
  especially when adding products" — a speed follow-up to the camera
  barcode scanner, touching only the shared component both the till and
  the product forms use (`components/ui/barcode-scanner-modal.tsx`), so
  the fix applies everywhere scanning happens. Two changes: the scanning
  library's default 500ms gap between decode attempts was shortened to
  100ms (`new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts:
  100 })` — the installed @zxing/browser version takes an options object
  here, not a plain number, confirmed by `npm run typecheck`), and the camera
  is now started at a moderate 1280x720 resolution instead of its
  unconstrained (often much higher, and slower to decode per frame)
  native resolution, by switching from `decodeFromVideoDevice` to
  `decodeFromConstraints`. That switch also fixes a previously-disclosed
  first-run rough edge: when no camera yet has a label (before this
  origin has ever been granted camera permission), the component now
  asks directly for the rear (`facingMode: "environment"`) camera instead
  of guessing a device from an unlabelled list, so the very first scan on
  a brand-new install should no longer risk opening the front camera. No
  database, permission, or RLS surface — this is a client-side
  timing/config change to an existing component — so no migration and no
  security test changes.

- 2026-09-07 — "we need to add scan barcode feature in the add products
  section (barcode) so barcode of products automatically scans into the
  field with either scanner or phone camera" — a direct follow-up reusing
  `components/ui/barcode-scanner-modal.tsx` from the till's camera-scanning
  feature (above) rather than building a second scanner. A USB/Bluetooth
  scanner already worked here with no changes: it types into whichever
  text field has focus, same as a keyboard, and a barcode field was
  already a plain text input. The only genuinely missing piece was camera
  scanning, plus a visible "Scan" button so someone unfamiliar with the
  keyboard-wedge behavior has an obvious way in either way.
  `components/ui/field.tsx` gained an optional `trailing` prop (an element
  rendered beside the input — purely additive, every existing caller is
  unaffected) so a "Scan" button could sit directly next to the barcode
  input without a bespoke layout. Wired into both places a barcode is
  entered: the new-product form's per-variant rows
  (`app/(app)/products/product-form.tsx`, tracking which row a scan should
  fill since more than one row can exist at once) and the single-variant
  add/edit form (`app/(app)/products/variant-form.tsx`, whose barcode
  field became controlled — it was plain `defaultValue` before — solely so
  a scan result has somewhere to land; every other field there is
  untouched). No database, permission, or RLS surface — this only ever
  fills a text field the user could otherwise type into by hand — so no
  migration and no security test changes.

- 2026-09-07 — "Now let's move on with the scanning and printing" —
  scanning via a USB/Bluetooth barcode scanner and printing a receipt
  already existed (the till's search box has always treated a scanner as
  a keyboard typing a code then Enter, and `app/(app)/sales/[id]/receipt`
  already formats and prints a receipt through the browser's own print
  dialog, per-business paper-size setting and all). Two genuinely new
  pieces this covers, plus one design decision that turned out to need no
  new code at all:

  1. **Cash drawer, wired through the printer.** Asked directly before
     writing anything, since the options differ enormously in browser
     support: direct in-app hardware control (WebUSB) only works in
     Chrome/Edge on a desktop — Safari, Firefox, and effectively every
     mobile browser cannot use it, which would leave a till on a phone or
     iPad with no printing or drawer function at all. Chose instead to
     rely on the receipt printer's own driver setting that pulses the
     drawer on any print job — the normal setup for a thermal printer with
     an attached drawer, and already fully working with zero new code,
     since printing already went through the browser's print dialog. This
     is a hardware/OS-configuration task for the shop, not something the
     app can verify or control from here — stated plainly rather than
     claimed as "done" when it depends on printer driver configuration
     outside this codebase.

  2. **Camera-based barcode scanning**, for a till running on a phone or
     tablet with no USB/Bluetooth scanner attached — the actual new
     scanning surface (a plain USB/Bluetooth scanner needed no changes).
     `components/ui/barcode-scanner-modal.tsx` decodes frames off a live
     `<video>` feed using `@zxing/browser` (a new dependency) rather than
     the native `BarcodeDetector` API, which has no Safari/iOS
     implementation — "phone camera for mobile" would not hold on every
     phone otherwise. `till.tsx` gained a "Scan" button next to the search
     box, and its old inline exact-barcode-match logic was pulled out into
     a shared `tryAddByBarcode()` so a USB scanner's keystrokes and a
     camera's decoded text are matched against the catalog exactly the
     same way — they can never quietly disagree about what a code means.
     Worth naming rather than glossing over: the very first scan on a
     brand-new browser install may default to the front camera on some
     phones (camera labels needed to prefer the rear one are only
     populated once permission has been granted at least once for that
     origin) — self-corrects from the second attempt onward.

  3. **"No sale"** — asked directly whether staff should be able to open
     the drawer without a sale (giving change, correcting a mistake): yes,
     but permission-gated and logged, since an always-available
     drawer-open button is a known till-fraud vector. Migration 0044 adds
     `sales.no_sale` — the first new permission this project has added to
     the catalog since the initial 0010/0011 seed, and so also the first
     time a `role_permissions` backfill migration (granting it to every
     existing business's Owner and Manager roles, not only new ones) has
     actually been needed — see docs/RBAC.md, which had already flagged
     this exact situation as hypothetical when 0040 chose to reuse
     `products.*` for services rather than face it early. Cashier does not
     get it by default. `openDrawerNoSale()` (`app/(app)/till/actions.ts`)
     never touches the `sales` table — there is no transaction, on purpose,
     so it can never be mistaken for a real one in reports — and records
     the event exclusively via `log_audit_event()` (0008). Because a plain
     Cashier holding `sales.no_sale` but not `audit.view` cannot read that
     row back under `audit_logs`' own RLS policy, the printable slip is
     composed and returned directly by the same server action rather than
     fetched back afterward from a separate page. `till.tsx` prints it
     through the same browser-print-dialog path as a sale receipt (a
     `print:hidden` wrapper around the normal till UI, with the slip as
     the one thing left visible to print), reusing the printer's own
     drawer-kick-on-print behavior rather than needing a second hardware
     integration.

  No SQL test changes were needed for the camera scanner or the printing
  architecture itself (neither has a database-enforced security surface);
  `tests/security/tenant_isolation_and_rbac.sql` gained assertions for
  `sales.no_sale`: catalogued under the `sales` category, correctly
  granted to Owner/Manager on both the pre-existing demo business (proves
  the backfill reached already-registered rows) and a business registered
  fresh within that same test file after 0044 (proves the updated seed
  function itself grants it going forward), and confirmed absent from
  Cashier by default. Verified against a from-scratch local Postgres
  rebuild through all 44 migrations with the full 18-file security suite
  green. `@zxing/browser`'s exact TypeScript surface could not be
  confirmed against the real package in this sandbox (no npm registry
  access here) — its runtime API is stable and this is disclosed plainly
  rather than assumed correct, in case one type name needs adjusting once
  `npm run typecheck` runs for real.

- 2026-09-06 — Follow-up to the till-availability toggle shipped earlier
  the same day: "some available products and services (6 or more) should
  always be seen in the till page" — the toggle itself (below) only
  controlled which items were *eligible* to appear; the till's own UI
  still required typing something into the search box before any product
  or service showed up at all, so a brand-new cashier facing an empty
  screen had no way to discover what was sellable without already knowing
  a name or SKU. This is a client-only change — `app/(app)/till/page.tsx`
  was already fetching every `available_at_till` item up front for the
  search-matching logic, so no new query, migration, or permission check
  was needed.

  `app/(app)/till/till.tsx` now renders a tappable grid of every available
  product/service by default (sorted the same way the search results
  already were), inside a scrollable panel so a large catalog doesn't push
  the payment panel off-screen; typing in the search box still replaces it
  with the existing filtered list, unchanged. An empty grid (a business
  with nothing currently set to show at the till) explains why in plain
  language and points at the toggle rather than rendering a blank panel.
  No test changes — nothing here is security- or permission-relevant, and
  there is no existing component-level test harness for `till.tsx` to
  extend; verified by manual code review only, which is disclosed here
  rather than left unstated.

- 2026-09-06 — "Some products and services should be available in the
  till" — before this, the till showed every active product/service
  automatically; there was no way to keep something in the full catalog
  (reports, sale history, editing) while keeping it out of checkout
  specifically. Asked which shape this should take before writing code: a
  brand-new independent toggle defaulting to visible for everything that
  already exists (chosen), versus tying visibility to something that
  already existed like category or branch.

  Migration 0043 adds `products.available_at_till boolean not null default
  true`, joins it into `enforce_product_field_permissions()`'s existing
  products.edit bucket alongside category_id/duration_minutes (0041) — a
  catalog attribute, not a lifecycle transition, so it needs no new
  permission and no confirmation dialog, unlike archiving — and adds a
  composite index (`business_id, status, available_at_till`) since the
  till's own query now filters on both together. `app/(app)/till/page.tsx`
  gained that filter directly on the product_variants query (an `!inner`
  embed's own column, so a hidden item is excluded server-side, not just
  hidden in the UI). The product/service detail page gained a "Hide from
  till" / "Show at till" toggle (reusing StatusToggleButton, no confirm
  needed since it's fully reversible either way) and an amber "Hidden from
  till" badge, mirrored as a smaller badge on the products list.

  `tests/security/services.sql` gained a new section verifying three
  things against a real Postgres instance: the column defaults to true and
  an Owner can toggle it without touching status; a staff member with
  neither products.edit nor products.archive is blocked by the coarse RLS
  gate; and — the test that actually matters for proving the trigger
  change landed correctly, not just the RLS gate — a purpose-built role
  holding products.archive but NOT products.edit passes RLS (so the
  trigger genuinely runs) and is still refused specifically on this
  column, while the same role can still archive/restore the product
  normally. That distinction is what proves available_at_till was
  correctly bucketed under products.edit in the trigger itself, rather
  than silently left ungated (which the RLS-only test on its own would not
  have caught, since a zero-permission caller is stopped by RLS before the
  trigger ever runs).

- 2026-09-06 — Two follow-ups to the categories table shipped a day
  earlier (0041), both requested directly: (1) "categories... should be
  optional and ability to write your own category" — categories were
  already optional (a product/service can stay "Uncategorized"); the real
  gap was requiring a trip to Products > Categories before a brand-new
  category could be used. Closed at the application layer only (migration
  0042 touches nothing about how categories are structured, only what a
  new business starts with — see next point): the product/service
  create/edit forms' category field is now a type-to-create combobox
  (`components/ui/category-combobox.tsx`) instead of a locked dropdown.
  What's typed is resolved server-side by a new `resolveCategoryId()`
  helper in `app/(app)/products/actions.ts` — an existing category is
  matched case-insensitively and reused (or reactivated, if archived), so
  "hair" and "Hair" can never become two rows; a name matching nothing is
  created on save, still gated by `products.create` exactly like the
  dedicated Categories page already was, checked freshly inside the
  helper (not assumed) since editing a product only requires
  `products.edit`. (2) "should be more [starter categories], and make
  sure samples are not duplicates" — the six starters from 0041
  (Hair/Nails/Beauty/Grooming/Treatment/Other) undersold a table meant to
  serve retail shops as much as salons. Migration 0042 expands
  `seed_default_categories()` to sixteen (adding Beverages, Electronics &
  Gadgets, Fashion & Clothing, Footwear & Accessories, Groceries & Food,
  Health & Wellness, Household & Cleaning, Skincare, Spa & Massage,
  Stationery & Office to the original six, chosen to avoid near-duplicate
  overlap with what already existed — e.g. no separate "Barbering" next to
  "Grooming") and re-runs the seed for every already-registered business
  using the same idempotent `on conflict (business_id, name) do nothing`
  pattern 0041 itself used, so a business that already renamed or archived
  one of the original six is untouched — only the ten new names are added.
  `tests/security/categories.sql` was updated to expect the new sixteen
  and gained a dedicated assertion that no two starter categories collide
  case-insensitively. The type-to-create form behavior is application-layer
  logic without an equivalent SQL-level uniqueness constraint (categories'
  `unique(business_id, name)` has always been case-sensitive, matching
  every other naming column in this project), so it was verified by manual
  code review of `resolveCategoryId()` rather than a new automated test —
  disclosed here rather than glossed over, per this project's standing
  rule against faking completion.

- 2026-09-06 — Full Services management page, kept "in line with the
  Products page" per the user's own instruction (one catalog, one set of
  patterns) rather than a parallel system, plus three pieces of scope the
  user explicitly chose to add now rather than defer: real categories,
  service duration, and a "revenue by renderer" report.

  Before writing code, four genuine forks in the request were surfaced via
  clarifying questions rather than guessed at (per this project's standing
  rule): (1) whether a service's renderer needs a special tag/permission —
  kept as-is, any active staff member chosen at sale; (2) whether
  categories should become a real per-business table instead of products'
  free-text `category` column — yes, shared by products and services
  alike; (3) whether a basic "revenue by renderer" report should be built
  now — yes; (4) whether a confirmation dialog before deleting/deactivating
  should be added — yes, to both Products and Services.

  `supabase/migrations/0041_services_management.sql`: a new `categories`
  table modelled closely on `expense_categories` (0031) — per-business,
  archived not deleted, seeded with a starter set (Hair, Nails, Beauty,
  Grooming, Treatment, Other) both for every existing business and via an
  `AFTER INSERT ON businesses` trigger for new ones — but gated by
  `products.create`/`products.edit` rather than a new permission set, for
  the same "never backfilled a permission" reasoning `docs/RBAC.md`
  documents for services themselves. `products.category` (free text) is
  **fully replaced**, not kept alongside a new `category_id` — every
  business's existing free-text values were turned into real category rows
  first (deduped case-insensitively per business, so "Hair"/"hair"/"HAIR"
  become one row, and matched against the just-seeded defaults so a shop
  that already typed "Hair" gets the seeded "Hair" back rather than a
  duplicate) before the old column was dropped. Verified directly against
  a real, non-empty Postgres database seeded with exactly that kind of
  messy data (case variants, whitespace padding, a null category) — not
  just against an empty from-scratch migration. `products.duration_minutes`
  was added with the same treatment `opening_stock` gets for a service in
  0040: validated when given, forced to `null` for `type='product'`
  regardless of what is sent. `create_product()` gets a new overload
  (dropping the old exact 10-argument signature first, per the
  established "drop, don't just add a default" rule) taking
  `p_category_id uuid` instead of free text and a new
  `p_duration_minutes`, validating the category belongs to the caller's
  own business exactly as branch ids already are. A new
  `service_provider_performance()` function (mirroring `staff_performance()`
  from 0030, SECURITY INVOKER like every report) answers a genuinely
  different question than that function: it attributes each **service
  line's** revenue to `sale_items.rendered_by` (who did the work), not a
  whole sale to `sales.cashier_id` (who rang it up) — one sale can have a
  different cashier than renderer, and several renderers across its lines
  (the barber-A/barber-B example from 0040's own header), which
  `staff_performance()` cannot represent. Every existing test file's
  `create_product()` calls (27 call sites across 11 files) were updated
  for the new signature as part of this change — a parameter type change
  breaks every existing caller by design, and the test suite is a caller
  too. `tests/security/categories.sql` (new) and new assertions appended
  to `tests/security/services.sql` cover RLS/permission gating, seeding,
  uniqueness, cross-tenant isolation, and `service_provider_performance()`
  (including a two-renderer-on-one-sale case, and a refund netting
  correctly against only the renderer whose line came back). The full
  CI-ordered security suite (18 files now) passes with zero regressions
  against a from-scratch database.

  Application layer: a new shared `components/ui/confirm-dialog.tsx` — the
  first modal/dialog component in this codebase (there was no prior
  reusable precedent, only a bespoke two-step reveal in
  `expenses/void-form.tsx`) — wired into `products/status-toggle-button.tsx`
  as a strictly **optional** `confirm` prop, defaulting to off, so the
  other nine call sites of that shared component (sales, staff, admin
  businesses, suppliers, purchase orders, awaiting-payment, payment
  settings, customers) are completely unaffected, per the user's own
  scoped approval ("Products and Services") and the master spec's rule
  against touching unrelated functionality. A new Categories management
  page (list with active/archived tabs and an icon picker drawn only from
  a curated `lib/ui/category-icons.ts` allowlist of confirmed-real
  lucide-react exports — never an arbitrary client-supplied icon name) is
  reached from a new "Categories" leaf in the existing Products nav group,
  reusing `canViewProducts`. The products list gained a real category
  filter (by id, against the new table), a price-range filter (switching
  the `product_variants` embed to `!inner` only while a price filter is
  active, so a plain listing is unaffected), a service duration display,
  a live item count, a "Clear filters" control, and a proper empty state
  with an "Add Service"/"Add Product" call to action reading exactly as
  specified ("No services yet. Add your first service to start offering
  services through the POS."). The product/service create and edit forms
  now use a category `<Select>` populated from the real table instead of a
  free-text box, and show a duration field only for a service. The
  existing `/reports/sales` page — not a new route — gained a "Who
  rendered what" section mirroring its own existing "Who sold what" table,
  reusing `REPORTS_VIEW`/`ReportShell`/`loadReportContext()` exactly as
  they already stood, per the explicit instruction to extend existing
  reporting architecture rather than duplicate it.

  **What was not built, stated plainly rather than silently under-
  delivered**: the spec's "search/filter by assigned staff" is not
  implemented — Q1's own answer (any active staff, chosen at sale, no
  persisted assignment) means there is no staff field on a product/service
  to search or filter by in the first place; building one would have
  contradicted the very answer that was just given. If per-service staff
  assignment is wanted later, that is a new, separate design conversation.

- 2026-09-06 — Added services (braiding, sewing, barbering...) to the POS,
  functional exactly like products, with each sale line tied to whoever
  actually did the work. Requested directly: "sales or service rendered
  should be tied to person who rendered so we track records — example
  barber A renders hair dying and barber B renders dreadlocks."

  Explained the design and asked three clarifying questions before writing
  any code (per this project's standing rule to discuss major architectural
  changes first): whether a renderer needs a special tag/permission (any
  active staff member, chosen), whether managing services should use a new
  `services.*` permission set or reuse `products.*` (reuse, chosen — see
  `docs/RBAC.md`'s new "Services reuse products.*" section for why this
  wasn't a close call: this project has never once backfilled a permission
  onto existing tenants' roles, since `seed_default_roles_for_business()`
  only runs at registration), and whether a dedicated staff-performance
  report was wanted now or later (later — just capture the data, chosen).

  A service is a `products` row with `type = 'service'` (`0040_services.sql`)
  — same table, same variants, same till search, same tax handling, same
  receipts — not a parallel schema. `create_product()` (new 10-arg overload,
  dropping the old 9-arg one first per the pattern documented in 0026's own
  header) ignores opening stock and never requires a branch for a service,
  regardless of what a tampered request sends, since a service never
  carries stock. `sale_items.rendered_by` (new column) records who did the
  work — required and server-validated by `create_sale()` (must be an
  active profile in the caller's own business) for a service line, forced
  to `null` for a product line regardless of client input. This is
  deliberately **not** an authentication boundary like `cashier_id` (0039):
  naming a colleague as a renderer grants no privilege and unlocks no data,
  so there is no PIN/password check on them, only tenant-membership and
  active-status checks — see `docs/RBAC.md` for the contrast spelled out in
  full. `create_sale()`/`create_refund()` skip the stock ledger entirely
  for a service line by simply never inserting an `inventory_movements`
  row for it — stock validation lives inside `apply_inventory_movement()`'s
  trigger (0015), not inside `create_sale()` itself, so omitting the insert
  is sufficient; a refund of a service line is never treated as a restock,
  even if the client explicitly asks for one.

  Verified against a real Postgres instance before being called done: a
  bug in the new `create_product()`/`create_sale()` bodies (an invalid
  `RAISE`-format `%s` instead of PL/pgSQL's bare `%`) was caught before
  ever running the migration; a second bug in the new
  `tests/security/services.sql` itself (a `create table` running under
  `set role authenticated`, which lacks `create` on schema `public`) was
  caught on first run and fixed to match the same reset-role-before-DDL
  pattern every other security test file already uses. The full CI-ordered
  security suite (17 files, adding `services.sql`) passes with zero
  regressions against a completely from-scratch database (stub + all 40
  migrations + seed, not an incremental apply).

  Application layer: a Product/Service toggle on the add-product form
  (type is fixed at creation — there is no convert-in-place flow); a
  Services/Add Service pair in the Products nav group and a type filter
  tab on the products list, both reusing `canViewProducts`/
  `canCreateProducts` rather than new permission keys; the till never
  merges two service cart lines together (a product still merges by
  scanning twice — a service always gets a new line, since "barber A did
  the braiding, barber B did the dreadlocks" needs two lines of possibly
  the same service with two different renderers) and shows a "Who rendered
  this?" picker per service line, disabling checkout until every service
  line has one; the sale detail page shows "Rendered by {name}" under a
  service line; the refund form replaces the "back on the shelf" checkbox
  with a static note for a service line, since the database ignores that
  choice for one anyway. **Scope decision, stated plainly here rather than
  silently under-delivered**: only the internal sale detail page
  (`/sales/[id]`) shows `rendered_by` — the printed customer receipt
  (`/sales/[id]/receipt`) does not, which is narrower than this entry's own
  early framing of "receipt and sales history/detail view." No dedicated
  revenue-by-staff report was built, per the user's own "just capture it
  for now" choice — the data is on the row, ready for one later.

- 2026-09-06 — A Cashier now sees only their own sales, refunds and
  payments; Managers/Owners (anyone with `reports.view`) still see
  everything. Requested directly: a Cashier holding `sales.process` could
  previously read every sale ever rung up business-wide, not just their
  own till — `sales_select`/`sale_items_select`/`refunds_select`/
  `refund_items_select`/`sale_payments_select` granted full visibility to
  `sales.process` OR `reports.view`, an unconditional "or" with no
  per-row restriction on the `sales.process` side. Fixed entirely at the
  RLS layer (`0037_cashier_own_sales_visibility.sql`) by scoping that
  branch of each policy to the caller's own `cashier_id` — the
  PIN-verified identity at the till, not necessarily whoever is logged
  into the browser on a shared device. Full rationale, and the known,
  deliberate limitations that come with matching strictly on `cashier_id`
  (the stricter of two options considered, chosen explicitly), are in
  `docs/RBAC.md`.

  **Found and fixed by actually running the full security test suite
  against a real Postgres instance before shipping** (per this project's
  standing rule against faking completion): narrowing those SELECT
  policies also narrowed what `create_sale()`/`create_refund()` could see
  when computing the next `R-NNNNNN`/`RF-NNNNNN` sequence number — both
  run as the calling cashier, invoker rights, so their own numbering
  query was newly subject to the same restriction. A second cashier's
  next sale would compute a receipt number a colleague had already used
  and fail outright on the unique constraint — reproduced immediately by
  the test suite, not a theoretical risk. Fixed in the same change
  (`0038_fix_numbering_after_cashier_rls.sql`) with two narrow
  `SECURITY DEFINER` helpers, `next_receipt_number()`/
  `next_refund_number()`, that hand back nothing but the next number —
  computed across every sale/refund in the business regardless of the
  caller's own RLS-scoped view — in the same spirit as the existing
  `set_profile_pin()`/`verify_profile_pin()` helpers (0018). This does
  not reopen `sales_select`/`refunds_select` for anything else. Also
  updated `tests/security/notifications.sql`'s stuck-payment assertions,
  which had (correctly, once traced through) started failing for the
  same underlying reason: the stuck-payment alert is computed by reading
  `sales` directly under the caller's own RLS, so a Cashier now sees it
  only for their own pending sale, not a colleague's — the test asserted
  the old, business-wide expectation and needed updating to match the
  now-intended behavior.

- 2026-09-06 — The till PIN now only ever confirms the account that is
  actually signed in; it can no longer be used to "become" a colleague.
  Requested directly. Before this, `verify_profile_pin(p_profile_id, p_pin)`
  let any authenticated user verify any colleague's PIN in the same
  business — it checked that the target profile belonged to the caller's
  own business, but never that the target *was* the caller. That was the
  exact mechanism behind the till's "Who's at the till? Pick your name"
  screen (a shared-till convenience for a device that stays signed in as
  one account all day while different people PIN-verify in turn), and the
  gap it left: knowing or guessing a colleague's short PIN was enough to
  attribute a sale or refund to them without them being the one who rang
  it up — the exact risk `docs/RBAC.md` had documented as a known,
  deliberate limitation when 0037/0038 shipped.

  Fixed by design discussion before any code: the user was walked through
  the current model and its gap, then asked (via three targeted
  clarifying questions across two rounds) how switching cashiers on a
  shared till should work, whether the PIN should be required on every
  till page load, and — once it was pointed out that a literal "every
  load" reading would mean re-entering a PIN after *every single sale*
  (`completeSale()` redirects to `/sales/[id]`, whose "back to till" link
  is a fresh page load) — how strict that requirement should actually be
  once that consequence was visible. The resulting design
  (`0039_till_pin_self_only.sql`):

  - `verify_profile_pin()` is now single-argument (`p_pin` only) and
    always checks it against `auth.uid()` — there is no parameter left to
    name a different target with, not even by tampering with a request.
  - `create_sale()`/`create_refund()` keep the `p_cashier_id` parameter
    (so neither needed a new overload) but no longer trust it: `cashier_id`
    is always set to `auth.uid()` server-side, and a client-supplied value
    that doesn't match the caller is now a hard `42501` rejection.
  - The till's 12-hour signed-cookie session (`lib/auth/till-session.ts`)
    is kept, but `readTillSession()` now refuses to honour a cookie whose
    identity doesn't match the currently signed-in account, so an unlock
    can never survive a switch to a different login.
  - Switching cashiers on a shared device is a new, explicit "Switch user"
    step (`app/(app)/till/actions.ts`) that performs a real Supabase Auth
    password sign-in — reusing the exact mechanism `app/(auth)/login/actions.ts`
    already uses — rather than a PIN check against someone else's hash.

  Net effect on `docs/RBAC.md`'s "known, deliberate limitation": the
  `cashier_id`/`created_by` mismatch it described can no longer happen for
  any sale or refund made from this migration forward (see that document
  and `docs/AUTH.md`'s till section for the updated detail). Verified
  against a real Postgres instance before being called done, per this
  project's standing rule: `tests/security/pin.sql` was rewritten (its
  old Section 3 asserted, as a *positive* case, that a cashier could
  verify a colleague's PIN — precisely the behavior this migration
  removes) rather than weakened or deleted, and `tests/security/sales.sql`
  / `tests/security/refunds.sql` each gained a dedicated test proving the
  new `42501` guard actually rejects a mismatched `p_cashier_id` and falls
  back to the caller when `null` is passed. The full CI-ordered security
  suite (all 16 files) passes against a from-scratch database with all 39
  migrations applied.

- 2026-09-06 — Fix: staff invite links landed on the login page instead of
  letting the invited person set a password. `inviteStaff()`
  (`app/(app)/settings/staff/actions.ts`) was sending the invitee to
  `app/auth/confirm/route.ts`, but that route only understands the PKCE
  `?code=` query param used by `signUp()`/`resetPasswordForEmail()` —
  flows the invitee's own browser initiates, generating a matching
  `code_verifier` for the exchange. `inviteUserByEmail()` is triggered
  server-side by whoever sends the invite, so there's no browser-side
  `code_verifier` for a `?code=` to pair with; Supabase instead appends the
  session as a URL `#fragment` (`#access_token=...`), which never reaches
  the server at all. Fixed by giving the invite its own destination,
  `app/(auth)/accept-invite/page.tsx` — a client component that reads the
  fragment itself, establishes the session client-side, and only then
  shows the "choose a password" form. Full explanation in `docs/AUTH.md`.
  This was found by actually testing the invite email end-to-end against
  the live Vercel/Supabase deployment (which also surfaced two unrelated,
  now-fixed dashboard misconfigurations along the way: `NEXT_PUBLIC_APP_URL`
  missing in Vercel, and Supabase's Auth URL Configuration still pointing
  at a stale domain) — not something a local test suite alone would have
  caught, since it's specific to how Supabase's hosted Auth server
  constructs the redirect for an admin-triggered invite.

- 2026-09-06 — Correction: the support email fallback (`lib/env.ts`,
  `.env.example`) was `support@busihub.app`, entered believing it was
  already a real, working address. It wasn't — `busihub.app` was never
  registered, so that address could never have received mail, meaning
  the "Contact Busihub support" text on the suspended-account screen
  pointed nowhere. Also surfaced while wiring up email for the staff-
  invite feature below: Supabase's built-in email sender is capped at 2
  messages/hour, which the invite flow hit almost immediately in testing.
  Both are fixed the same way — a real, reachable address
  (`macfelix13@gmail.com`) as the fallback, and Supabase's SMTP now
  points at Gmail (`smtp.gmail.com`, an app password, configured in the
  Supabase dashboard — no code involved). Revisit both once a real
  `busihub.app` mailbox and a verified sending domain exist; nothing here
  forecloses that, it's a one-line env var change plus a Supabase
  settings change.

- 2026-09-06 — Staff management (invite, roles, deactivate) and a business
  audit log — the first UI for RBAC permission keys (`users.manage`,
  `roles.manage`, `audit.view`) that have existed since 0005/0010 but had
  no way to actually add a colleague until now (0009's own comment already
  said profile rows are "created server-side... as part of registration/
  staff-creation" — the second half of that sentence just hadn't been
  built).

  **How a new account gets created**, and why: an owner/manager fills in a
  name, email, branch, and role (`/settings/staff/new`). Supabase Auth
  Admin's `inviteUserByEmail()` creates the `auth.users` row and sends
  Supabase's own "set your password" email — deliberately not a custom
  email service, since Supabase already sends the registration
  confirmation email today with no extra configuration. `invite_staff_member()`
  (new migration, `0036_staff_management.sql`) then creates the profile
  and branch/role assignment in one transaction, through the caller's own
  RLS-scoped session — it re-derives the caller's `business_id` from their
  own profile rather than accepting one as an argument, so there is no way
  to invite someone into a business other than the caller's own no matter
  what a tampered request claims. Full walkthrough in `docs/AUTH.md`.

  **Two guards that weren't asked for but were clearly needed** once the
  schema was actually looked at: `seed_default_roles_for_business` (0011)
  gives Manager `users.manage` but not `business.manage` — without a
  check, a Manager could invite a brand-new colleague and directly hand
  them the Owner role, instantly outranking the Manager who created them.
  Granting (or later moving someone into) Owner now additionally requires
  `business.manage`. Separately, `update_staff_role()`/`set_staff_status()`
  refuse a change that would leave the business with zero active
  Owner-role holders, and refuse to let anyone act on their own row —
  self-service role/status changes aren't offered anywhere, so one
  mis-click can't strand a whole business with no one able to undo it.
  Both guards, and the ordinary permission checks, are exercised in the
  new `tests/security/staff_management.sql` — run against a real local
  Postgres 16 (migrations + seed + the full existing security suite, in
  the same order `.github/workflows/ci.yml` runs them) before this ever
  reached the apply script, not just written and assumed correct.

  **A gap found and fixed while building this, not left for later**:
  `profiles.status` has existed since 0004, but nothing anywhere ever
  checked it — the exact same "declared but never enforced" history
  `businesses.status` had before the Super Admin phase. Now that
  `set_staff_status()` can actually flip it, `app/(app)/layout.tsx` checks
  it too (same place, same pattern as the business-status check above
  it): a deactivated colleague sees a plain "Account deactivated" page and
  is signed out of every route under `(app)`, not just hidden from a
  staff list somewhere.

  **Audit log** (`/settings/audit-log`, gated on `audit.view`): reads
  `audit_logs` scoped to the caller's own business, with human-readable
  labels for every action this app currently writes — which, before this
  phase, was only `business.registered` and `user.pin_set` (0011) plus
  whatever Super Admin actions (0035) happened to target this business.
  The new staff-management functions add `user.invited`, `user.role_changed`,
  `user.deactivated`, and `user.reactivated`, so a real business now has a
  genuinely useful trail from day one instead of an almost-empty page.

  **Explicitly out of scope for this phase**: creating or editing custom
  roles/permissions through the UI. The schema already supports it
  (`roles.manage`, `role_permissions`) and nothing here forecloses it, but
  the Staff pages only let an owner/manager assign the six built-in roles
  to a colleague — see `docs/RBAC.md`.

- 2026-09-05 — Real, configurable support contact on the suspended/closed
  screen. The account-suspended page (`app/(app)/layout.tsx`, added in the
  Super Admin phase below) told a locked-out owner to "contact Busihub
  support" without saying how. Two new functions in `lib/env.ts`,
  `supportEmail()` and `supportPhone()`, follow the exact pattern the file
  already used for `supabaseAppUrl()`: read an env var
  (`NEXT_PUBLIC_SUPPORT_EMAIL` / `NEXT_PUBLIC_SUPPORT_PHONE`), falling back
  to today's real values (`support@busihub.app`, `+233543945668`) if unset.
  Neither is hardcoded into the JSX — support contact details can change
  later with a Vercel env var update and a redeploy, no code change, per
  the explicit requirement that these be editable going forward. The page
  now renders a `mailto:` link and a `wa.me` WhatsApp link built from the
  same phone number, shown for both `suspended` and `closed` (previously
  only `suspended` mentioned support at all — an owner whose account was
  closed by mistake needs a way to reach Busihub just as much). Documented
  the two new optional env vars in `.env.example` alongside the existing
  `NEXT_PUBLIC_APP_URL` entry.

- 2026-09-06 — Super Admin platform-operator console (first version):
  a business list, a business detail page, and Suspend/Reactivate,
  reachable only by Busihub's own platform staff, never by any tenant.

  **Correction to what I told the user going in.** Asked whether the
  codebase had any support for a cross-tenant admin console, I said no —
  without actually checking first. That was wrong. `profiles.is_super_admin`
  (0004), the `app_is_super_admin()` RLS escape hatch threaded through
  every single tenant table's policies (0008, and then every migration
  after it), `businesses.status` including `suspended` (0002), and the
  `audit_logs` table with `business_id` explicitly nullable "for
  platform-level events" (0007) — all of this was deliberately designed
  in the earliest phases of this project. It was just never finished:
  nothing could ever actually set is_super_admin (the column existed,
  locked down, with no function allowed to write it), no route used the
  escape hatch, and businesses.status = 'suspended' was never read by
  anything. This phase completes that, rather than starting it.

  **0035_super_admin_console.sql** adds exactly one thing:
  `bootstrap_super_admin(p_user_id)`, following the same
  privileged-write pattern already used for `set_cashier_pin` (0011) —
  it flips the session-local flag the profiles trigger checks for,
  updates the row, and logs it. `EXECUTE` is explicitly revoked from
  `anon`/`authenticated`/`public`: Postgres grants a new function to
  PUBLIC by default, which both of those roles inherit, so without the
  revoke this would work today but be one accidental
  `supabase.rpc('bootstrap_super_admin', …)` away from being reachable
  from application code. It's runnable only by hand, as the Postgres/
  service role, in the Supabase SQL editor — matching the column's own
  comment from day one. No other schema changes; the console reads
  businesses/profiles through the RLS policies that already let a super
  admin through, and writes through `log_audit_event()`, which has
  existed since 0007/0008 but had never actually been called by any
  application code until this phase's Suspend/Reactivate actions.

  **A deliberately separate route tree**, `app/admin/*`, with its own
  layout — no AppShell, no Sidebar, no business/branch/till context. A
  Super Admin profile has `business_id = null` (the same constraint that
  requires every ordinary profile to have one), so there is no "current
  business" to scope a shared shell to, and keeping the two shells
  completely apart means no component can accidentally carry a
  "which business" assumption from one into the other. The layout's
  guard (`isSuperAdmin()`, checked fresh, never trusted from a prop) is
  UX only, same relationship every other layout guard in this app has to
  RLS: even if it somehow let the wrong person through, `businesses_select`
  still only returns that person's own single business, not the list.
  A non-admin hitting `/admin` lands on the ordinary `/dashboard`, not an
  error page — nothing suggests the console exists.

  **Suspend now actually does something.** Until this phase,
  `businesses.status = 'suspended'` was pure record-keeping — a
  suspended business's staff could sign in and use Busihub exactly as
  before, since no login check, middleware, or layout ever read it. One
  check added to `app/(app)/layout.tsx` (which already loads the
  business row) covers every route underneath, including the till: a
  non-active business renders a plain "account suspended/closed" page
  with just a sign-out button, instead of the dashboard.

  **The business list and detail pages are the one place in this whole
  app where a query is deliberately not scoped to a single business_id**
  — heavily commented as such at both call sites, specifically so it's
  never mistaken later for the tenant-isolation bug it would be
  everywhere else. Staff count and last-activity are computed in JS from
  a plain profiles query (grouped and reduced client-side, the same
  "fetch raw rows, aggregate in JS" idiom already used for customer
  balances) rather than a new SQL view, keeping this migration to just
  the one function.

  **Explicitly out of scope for this version**: impersonation / support
  login-as-a-business (a separate, higher-risk feature — breaking tenant
  isolation on purpose, even briefly and even for support, needs its own
  audit-heavy design before any code) and anything about plans or
  billing (there is no subscription concept anywhere in this schema yet
  — "which plan" isn't a real question until one is designed).

  **One known gap, noted rather than silently accepted**: if
  `log_audit_event()` itself fails inside `suspendBusiness`/
  `reactivateBusiness`, the status change still goes through — it's
  logged to the server console, not surfaced to the admin, so the
  action doesn't appear to fail for something that already succeeded.
  Worth revisiting if audit completeness for platform actions ever
  becomes load-bearing (e.g. a compliance requirement), but not before.

  Files: `supabase/migrations/0035_super_admin_console.sql` (new),
  `lib/auth/is-super-admin.ts` (new), `app/admin/layout.tsx` (new),
  `app/admin/page.tsx` (new), `app/admin/businesses/page.tsx` (new),
  `app/admin/businesses/[id]/page.tsx` (new), `app/admin/businesses/
  [id]/actions.ts` (new), `app/(app)/layout.tsx` (modified — adds the
  suspended/closed block and selects `status` alongside `name`).

- 2026-09-06 — Responsiveness pass, follow-up: fixed the notification
  bell dropdown running off the left edge of the screen on mobile,
  found from an actual phone-width screenshot rather than from reading
  the code — the kind of bug a source read alone would not have caught,
  since nothing in `notification-bell.tsx` looks wrong out of context.

  The panel was `absolute right-0` relative to its own button's
  wrapper, which is correct only if that button sits at the true right
  edge of the screen. It doesn't: in the header (`app-shell.tsx`), the
  bell sits to the *left* of "Sign out", not at the edge. Anchoring a
  320px-wide panel's right edge to that button's much-further-left
  position pushed the panel's left edge off-screen on a phone, cutting
  off the first several characters of every line ("Notifications" read
  as "...cations").

  Fixed by switching the panel to `fixed inset-x-4` (anchored to the
  viewport's own edges, with a fixed top offset matching the header's
  height) below the `sm:` breakpoint, where a phone-width screen makes
  the bell's position within the header matter; from `sm:` up, screens
  are wide enough that the original bell-relative `absolute right-0`
  popover was never actually at risk, so it's kept unchanged there.

  This is exactly the class of bug the four batches above could not
  have caught by reading source alone — the component's own code has
  no visible defect; the defect is in the *relationship* between two
  components (where the bell sits in the header) that only shows up
  once rendered at a real width. Worth remembering next time a "read
  every file" pass is called done: a few real screenshots at each
  breakpoint remain the only way to catch this class of bug.

- 2026-09-06 — Responsiveness pass, batch 4 (final): audited every
  Reports and Settings page — the four reports plus their shared shell
  (`reports/*`, 9 files) and Business/Payments/PIN settings (`settings/*`,
  9 files). **This closes the responsiveness pass** the user asked for
  across the app: Till/Dashboard/Products, Inventory/Sales, Suppliers/
  Customers/Expenses/Branches, and now Reports/Settings have all been
  read end to end and fixed where a real bug existed.

  Settings needed nothing — every form is already one or two columns,
  and the Paystack webhook URL (the one genuinely unbreakable long
  string on any of these pages) already had `break-all` applied from
  when it was first built.

  Reports had one real bug, in the shared `StatementLine` component
  (`report-shell.tsx`) that every report's line-item rows are built
  from. Most callers pass it fixed, app-defined labels ("Net profit",
  "Cost of goods sold") which are safe by construction, but two callers
  pass it merchant data with no length limit: the profit-and-loss
  report's expense-category breakdown (`row.category_name`) and the
  sales report's "Best sellers" list (`row.product_name`). Since the fix
  belongs to the shared component rather than each call site, every
  report gets it at once: `min-w-0 break-words` on the label so a long
  value wraps instead of forcing the row wider than the screen, and
  `flex-shrink-0` on the amount so it never gets squeezed by the wrap.

  Every report's own tables (receivables, stock valuation, staff
  performance) were already `overflow-x-auto` with a `min-w`, and every
  card grid already `grid-cols-2 sm:grid-cols-4` — both patterns
  established in earlier phases and left untouched.

- 2026-09-06 — Responsiveness pass, batch 3: audited every Supplier,
  Customer, Expense, and Branch page — list, detail, and forms
  (`suppliers/*`, `customers/*`, `expenses/*`, `branches/*`, 21 files in
  total including the shared `*-form.tsx` components).

  Almost everything held up: every form is already single- or
  two-column with `grid-cols-1 sm:grid-cols-2`; every detail page's
  field list already stacks label-over-value on mobile via `grid-cols-1
  sm:grid-cols-3`; list rows already go `flex-col` on mobile before
  becoming a row at `sm:`. Free-text fields that wrap on spaces (a
  supplier's payment terms, a branch's address) were left as-is — CSS
  lets a flex item shrink to its min-content and wrap before it
  overflows, so plain prose here was never actually at risk, matching
  the same reasoning already used for the header rows in batch 1.

  Two bugs did turn up, both from the same root cause as batch 2's
  refund-reason fix: a value with no natural break point sitting next
  to a fixed sibling in a plain flex row.

  1. `expenses/[id]/page.tsx`'s summary list uses a right-aligned
     `dt`/`dd` row (unlike the other three areas' stacking `dl` grid),
     and one of its rows is "Reference" — a Momo transaction id, cheque
     number, or receipt number, per the form's own placeholder text.
     Those are exactly the kind of long, space-free string that can't
     wrap and forces the row wider than the screen. Fixed by letting the
     value break mid-string when it has to (`min-w-0 break-words` on the
     `dd`) rather than changing the row's layout.
  2. `expenses/page.tsx`'s "Where the money went" category breakdown put
     a merchant-typed category name next to its amount with no
     protection; a long category name (nothing stops a business from
     naming one anything) could do the same. Fixed by truncating the
     name with an ellipsis instead — this row already has a progress bar
     underneath naming the same category, so truncation loses nothing a
     user needs.

  Not yet touched: Reports and Settings — the last batch before this
  request's responsiveness pass is complete.

- 2026-09-05 — Responsiveness pass, batch 2: audited every Inventory and
  Sales detail/action page — `inventory/page.tsx`, `inventory/[variantId]/
  page.tsx`, `inventory/stock-form.tsx`, `inventory/receive/page.tsx`,
  `inventory/adjust/page.tsx`, `inventory/count/page.tsx`, `sales/
  page.tsx`, `sales/[id]/page.tsx`, `sales/refund-form.tsx`, `sales/[id]/
  refund/page.tsx`, `sales/[id]/receipt/page.tsx`, and `sales/[id]/
  receipt/receipt-controls.tsx` — read end to end, not sampled.

  This batch was mostly a clean bill: the stock-count "on hand" list rows
  and the movement-history table already bound their content correctly
  (the table already scrolls in its own `overflow-x-auto` container);
  `adjust/page.tsx` and `count/page.tsx` are thin wrappers around the
  already-safe `StockForm`, and `sales/[id]/refund/page.tsx` is the same
  around `RefundForm`; the receipt page and its print/WhatsApp controls
  already wrap correctly, and the pagination fix from batch 1 was
  confirmed still in place on `sales/page.tsx`.

  One genuine bug, found by the same reasoning as batch 1 (unbounded,
  variable-length content next to a non-shrinking sibling, with no wrap
  or `min-w-0`): the refund-reason row on a sale's detail page rendered
  `refund_number`, method, and an optional free-text `reason` typed by
  staff at refund time, next to the refunded amount, in a bare `flex
  items-center justify-between`. A long reason could force the amount
  off the right edge on a phone. Fixed by adding `flex-wrap gap-x-3
  gap-y-1`, `min-w-0` on the text span, and `whitespace-nowrap` on the
  amount, so the text wraps onto its own line and the amount never
  breaks across lines.

  Not yet touched: Suppliers/Customers/Expenses/Branches (list, detail,
  and forms) and Reports/Settings — the remaining batches.

- 2026-09-05 — Responsiveness pass, batch 1: audited Till, Dashboard, and
  Products end to end against a 375px viewport, then swept the rest of the
  app for the same class of bug rather than stopping at three pages.

  Most of the app already held up well — every existing data table was
  already wrapped in its own `overflow-x-auto` container with a `min-w`,
  every multi-field form already collapsed to one column below `sm:`, and
  list rows already used `min-w-0`/`truncate` where a label could run
  long. That discipline predates this pass; it didn't need fixing.

  What did need fixing, found by grep across every page rather than by
  guessing: the pagination row ("Page 3 of 12 · 214 items" plus Previous/
  Next) on Products, Suppliers, Purchase Orders, Sales, and Expenses used
  a bare `flex items-center justify-between` with two buttons that don't
  shrink — on a narrow phone with a long count string, that is a real
  candidate for overflow, not a theoretical one. Fixed by adding
  `flex-wrap gap-2` to all five, so the buttons drop to their own line
  under the count instead of forcing width. The same unwrapped pattern
  also showed up on eight page/section header rows (a title+subtitle
  block paired with a primary action button, e.g. Products' "Add
  product") — lower risk in practice since CSS flexbox already lets
  wrapping text shrink below its own max-content width, but hardened the
  same way for consistency and margin, matching the `flex-wrap` pattern
  the dashboard's own filter rows already used.

  Not yet touched: everything outside this batch. This was a targeted
  fix for a confirmed, repeatable bug plus a consistency pass, not a
  page-by-page rebuild — the remaining batches (Inventory/Sales detail,
  Suppliers/Customers/Expenses/Branches, Reports/Settings) still need
  their own look before this request is fully done.

- 2026-09-05 — Navigation redesign: a left sidebar on desktop/tablet, a
  hamburger drawer on mobile. **This entry covers the nav shell only** —
  the broader ask ("make every page fully responsive... no horizontal
  scrolling, clipping, or elements going off-screen") is explicitly
  deferred to a follow-up pass across the app's existing pages, done in
  batches, per the user's own chosen sequencing. Do not read this as
  Phase-anything being "done" for responsiveness — it isn't yet.

  **Structure** grouped exactly as asked: Till and Dashboard stay direct
  links; Sales (the existing `/sales` history list — present in the old
  flat nav and carried over unchanged) sits with them since it is till
  activity, not a report; Products and Inventory stay separate dropdowns
  (each gaining the create/receive/adjust/count action pages that
  previously had no home in the nav); Orders/Suppliers/Customers/
  Expenses/Branches group under Operations; Reports, Settings (Business +
  Payments) get their own dropdowns; My PIN stays a direct link. Every
  sub-item's visibility is driven by the exact permission the target page
  itself already enforces (confirmed by reading each page's own
  `hasPermission`/`requirePermission` call, not invented fresh for the
  sidebar) — `components/layout/nav-items.tsx`'s `NavPermissions` is a
  UX convenience computed once in the layout, same as the flat nav it
  replaces; RLS and each page's own permission check remain the only
  real gate underneath.

  **lucide-react** (chosen over hand-drawn inline SVGs, by explicit
  choice) supplies one icon per nav item/dropdown. This sandbox has no
  open npm registry access (confirmed: `npm view lucide-react version`
  returns 403, same as other packages), so the exact published version
  and icon-name spellings could not be verified against the live
  registry — pinned to a long-stable, well-known set of icon names on
  training-knowledge confidence; if `npm install` reports an unknown
  export, that is the first thing to check.

  **Server Component children through a Client Component boundary.**
  `AppShell`/`Sidebar` need interactive state (the mobile drawer,
  manual group expand/collapse) and so must be Client Components — but
  `LogoutButton` has no `"use client"` of its own (it renders a client
  `SubmitButton` underneath, same pattern as everywhere else in this
  codebase) and cannot be imported into a Client Component's module and
  rendered as JSX there; React only allows a Server Component to reach a
  Client Component as an already-rendered element passed down through
  props/children. So `app/(app)/layout.tsx` (still a Server Component)
  renders `<NotificationBell />`/`<LogoutButton />` itself and passes the
  results into `<AppShell notificationSlot={...} logoutSlot={...}>` —
  `AppShell` never imports either component directly.

  **Group expansion is derived from the route on every render, not
  synced into state with an effect.** The first version used
  `useEffect(() => { ... setExpanded(...) }, [pathname])` to auto-open
  whichever group held the current route — the same shape of code
  (`setState` inside a `useEffect` body) that tripped
  `react-hooks/set-state-in-effect` on the notification bell earlier this
  week (see that entry below). Rather than risk the same lint failure a
  second time, `Sidebar` instead computes "is this group open" straight
  from `pathname` during render, with a small `overrides` state object
  recording only groups a person has manually clicked — no effect
  needed, and one fewer render per navigation than the effect-based
  version would have caused.

  Files: `components/layout/nav-items.tsx` (nav tree + permission types,
  new), `components/layout/sidebar.tsx` (new), `components/layout/
  app-shell.tsx` (new), `app/(app)/layout.tsx` (modified — computes the
  permission booleans and renders `<AppShell>` instead of the old
  `<header>`/flat `<nav>`), `package.json` (adds `lucide-react`).

- 2026-09-05 — Phase 15: notifications, in-app only, after asking rather than assuming the scope.

  Scoped with two questions before any schema was written: which channels
  (in-app only, chosen over SMS/email — both need a third-party account
  that is a real cost/business decision, not something a migration can
  provision), and which of five candidate events to cover this pass (low
  stock, customer credit limit reached, refund or void performed, sale
  stuck awaiting payment — purchase-order approvals deferred to a later
  pass on the same two patterns established here).

  **Two kinds of alert, deliberately handled differently.** Low stock,
  credit limit and stuck payment are STATES — true right now, false once
  the shelf is restocked or the balance is paid down, with no "this
  happened at 3:41pm" moment. Refund and void are EVENTS — something that
  happened once and stays true forever after. Storing a state as a row
  would either go stale (still shown after the shop restocks) or
  duplicate (a new row every time someone happens to trigger a re-check
  while it is still true) — the exact kind of derived truth this codebase
  has refused to trust since `stock_levels` and `customer_balances`. So
  0034 stores events (`notifications`, written once by `void_sale()`/
  `create_refund()`, the same functions that perform the action) and
  computes states fresh on every read (`notification_feed_base()`,
  composed from `low_stock_report()` (0030) rather than re-deriving what
  counts as low a second time). A restocked product simply stops
  appearing; there was never a row to clean up.

  **No new permission.** Visibility is entirely inherited from
  permissions that already exist and already gate the tables each alert
  reads from — inventory.view for low stock, customers.view for credit
  limit, sales.process/reports.view for stuck payments (all via the
  underlying table's own RLS, not re-checked here and risking drift from
  it), reports.view/sales.void/sales.refund for the event log. A Cashier
  and an Auditor genuinely see different bells, with no notifications
  code aware that roles exist.

  **The INSERT policy on `notifications` is the real gate, not the two
  call sites.** `void_sale()`/`create_refund()` run as the caller, not
  SECURITY DEFINER, so a direct PostgREST insert bypassing both entirely
  is only as dangerous as its WITH CHECK allows: business_id is forced to
  the caller's own, actor_user_id must be the caller themselves (nobody
  can attribute an event to a colleague), the referenced sale must be
  real and in-business, and the type must match a permission the caller
  actually holds. Confirmed by sabotage: weakening any one of those four
  clauses lets a Cashier holding neither sales.void nor sales.refund
  fabricate an event, or lets the Owner frame a colleague for one — both
  caught by tests/security/notifications.sql.

  **Read state is per-user and keyed by content, not by a foreign key.**
  `notification_dismissals` uses a stable text key
  (`low_stock:<variant_id>:<branch_id>`, `event:<notifications.id>`, …)
  because a STATE alert has no row to point a foreign key at.
  `mark_notification_read()`/`mark_all_notifications_read()` fill in
  user_id/business_id from the session rather than accepting either from
  the client — one more id off the never-trust-the-client list.

  **Deliberately not built: Supabase Realtime.** The original system
  diagram names it as the eventual mechanism, and it may still be right,
  but this sandbox has no live Supabase project to prove an `alter
  publication` statement actually delivers an event against your real
  project — shipping that unverified is exactly what "do not fake
  completion" rules out. The bell polls every 45 seconds instead: slower,
  but the entire path from RLS to render is something
  tests/security/notifications.sql can actually prove works. Wiring
  Realtime on top, once it's confirmed against the live project, is a
  follow-up, not a redesign.

  14 assertions in tests/security/notifications.sql, covering both
  severity mapping, the notification_settings.low_stock_alerts toggle,
  the credit-limit boundary (exactly at the limit alerts, one pesewa under
  does not), the 15-minute stuck-payment floor, event data integrity,
  cross-tenant isolation, the Cashier/Auditor permission split, the four
  INSERT-policy sabotages above, per-user read isolation, and a catalog
  check that nothing here is SECURITY DEFINER.

- 2026-09-05 — Phase 23 (brought forward): a performance pass, done with measurements rather than guesses.

  Requested ahead of sequence — "make it load fast" — scoped as a general
  review across page load, database query speed, and perceived speed on
  the patchy mobile connections Busihub's actual users are on. Everything
  below was found by reading the code and, for the database claims,
  proven with `EXPLAIN ANALYZE` against a seeded 300,000-row database
  (roughly a shop after a couple of years of trading), not assumed.

  **Every RLS-protected query in this database was running on one CPU
  core.** All six of the small security-definer helper functions behind
  Busihub's RLS policies (`app_has_permission`, `app_current_business_id`,
  and four more, 0008/0025) default to `PARALLEL UNSAFE` — Postgres's
  default for any function not explicitly marked otherwise — which forces
  Postgres to abandon parallel execution on any query that touches them,
  which in this database is nearly every query. Measured on
  `payment_method_breakdown()` (one of the dashboard's own functions) at
  300k rows: 1.77s single-threaded, 0.45s once the six functions were
  marked `PARALLEL SAFE` (0033) — a real change, since they are pure
  reads with no side effects, so this only changes how fast the answer
  arrives, never what it is. All 12 existing SQL security suites (251
  assertions) still pass unchanged with this migration applied.

  **The same investigation also tried, and failed, to fix a bigger
  problem, and says so rather than papering over it.** Every dashboard
  and report query filtering `sale_payments`/`sales` by date scales with
  the TOTAL number of historical rows in those tables, not with the
  period actually requested — "last 30 days" costs the same as "all
  time" once a shop has enough history. The cause: as soon as
  `app_has_permission()`'s OR-chain sits in the same `WHERE` clause,
  Postgres stops using date columns as an index condition at all, no
  matter the index shape (plain composite, partial, with or without a
  `coalesce()` rewrite) — proven by removing the RLS predicate and
  watching the identical index start working correctly (sub-2ms). This is
  a structural interaction between Postgres RLS and a joined,
  permission-checked query, not something an index in a migration can
  fix. 0033's header has the full writeup; the honest fix is architectural
  (a rollup table, or partitioning) and is real enough work that it
  belongs in its own migration once a business's data actually reaches a
  size where two seconds on a dashboard load is worth chasing further —
  not bundled into a parallel-safety fix that would have overstated what
  it verifiably does.

  **One RPC call, not two, on every single page load.** The (app) layout
  and the page it wraps were each independently asking "which business is
  this?" — the layout via its own `profiles` query, every page underneath
  it via its own `app_current_business_id()` RPC. `createServerSupabaseClient()`
  and `getCurrentBusinessId()` are now wrapped in React's `cache()`, and
  the layout calls the latter itself so it primes the memo before any
  page below it asks again. A Server Action is its own separate
  invocation, so it gets a fresh client and a fresh cache — nothing about
  who a request belongs to can leak between requests.

  **Four sequential round trips collapsed into one, on the page a cashier
  lands on after most sales and refunds.** `sales/[id]`,
  `purchase-orders/[id]`, `suppliers/[id]`, and the product-variant edit
  page were each awaiting two-to-four independent queries one after
  another when none of them depended on another's result — every one
  filters only on a route param. Now `Promise.all`. RLS scopes each query
  exactly as before; only the latency changed.

  **A loading state for the six busiest screens that had none at all** —
  most pointedly the till, which fires five-plus queries after every sale
  and, until now, showed nothing while they ran. `components/ui/skeleton.tsx`
  gives every route the same plain, numberless skeleton dashboard's
  `loading.tsx` already used (a skeleton with a real-looking number on it
  for even a fraction of a second is a number a shopkeeper could act on).

  **Three of four unbounded list pages now paginate; the fourth is
  flagged instead of rushed.** Products, suppliers, and purchase orders
  were shipping their entire filtered result set on every visit — fine at
  a few dozen rows, a real and growing cost at a few thousand. Paginated
  the same way sales/expenses already were: a bounded `.range()` plus a
  separate exact count, never "fetch everything and slice it in
  JavaScript". Customers was NOT touched: its "who owes money" filter and
  total are computed by joining every customer against every balance at
  the application layer, and pagination underneath that join would either
  paginate before the owing-filter is applied (wrong count) or require
  moving the aggregation into SQL first (its own considered change, not a
  find-and-replace of `.range()`). Left as unbounded and documented here
  rather than shipped half-correct.

  Till and inventory's own unbounded catalogue/customer fetch was raised
  and deliberately left as-is at the time: a real fix there is a bigger
  UX change (server-side search-as-you-type instead of an instant local
  filter) that belongs with Phase 16's offline/sync design, not bolted on
  ahead of it.

- 2026-09-03 — Phase 14: four reports, and three ways to get them out.

  **Profit and loss, receivables by age, stock valuation, and a sales
  report** — each one printable, copyable as WhatsApp text, and
  downloadable as CSV behind the `reports.export` permission that had
  been in the catalog unused since Phase 1.

  **The P&L is composed, not re-derived.** `profit_and_loss()` (0032) is
  built out of `sales_summary()` (0029) and `expense_summary()` (0031)
  rather than writing a third query over the same tables. Two definitions
  of "net sales" is two definitions that eventually disagree, and the day
  they disagree is the day a shopkeeper stops trusting both. The test
  asserts the composition holds, not merely that the statement is
  internally consistent — a self-consistent P&L built on its own second
  definition would pass the weaker test and still contradict the
  dashboard beside it.

  **Payments settle the oldest charge first.** That choice is the whole
  basis of the ageing buckets and it is stated on the report itself, not
  only in the migration: someone reading a 90-day column is entitled to
  know how a payment was applied to produce it. The ledger (0017) records
  a running account rather than payments against specific charges —
  which is how these accounts actually work in a shop — so the allocation
  had to be chosen, and oldest-first is the one that stops a customer who
  pays regularly from appearing to owe 90-day debt forever. Fixtures sit
  on the exact bucket boundaries (29/30/59/60/89/90 days), which is what
  makes an off-by-one fail: charges at 5/45/75/120 days would have passed
  an ageing function with every edge wrong.

  **Stock is valued at today's prices, which is the opposite of what cost
  of goods does.** Not an inconsistency: a past sale's profit must never
  move (0029), but stock in hand is worth what it is worth today. Lines
  in negative stock are surfaced rather than clamped, because they mean
  the ledger and the shelf disagree and every total above them is wrong
  until someone counts.

  **CSV export is a real endpoint, and its own security surface.**
  `lib/reports/csv.ts` handles RFC 4180 quoting and — the part that
  matters — neutralises formula injection: Excel, LibreOffice and Sheets
  all execute a cell beginning `=`, `+`, `-` or `@`, and Busihub lets
  people type product names, customer names and expense descriptions that
  all end up in a file emailed to a bookkeeper. A negative NUMBER is left
  alone so the accountant's columns still add up; a negative arriving as
  a string is not. The route re-checks the permission, re-validates the
  branch id, and calls the same SECURITY INVOKER functions, so an edited
  URL cannot return a row the caller could not already read.

  13 assertions in `tests/security/reports.sql` and 22 in
  `tests/unit/report-csv.test.ts`. Nine sabotages each confirmed to fail
  the SQL suite, including an exclusive end date (loses the busiest day
  of any report run in the afternoon), payments settling the newest
  charge, and `profit_and_loss` as `SECURITY DEFINER`, which shows the
  second business GH₵5,270 of takings it never had.

  `period.ts` moved from `app/(app)/dashboard/` to `lib/reports/`, since
  a report page depending on a file inside the dashboard route was the
  wrong way round.


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