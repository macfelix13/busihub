# Busihub -- apply-pin-security.ps1
# Fixes two real PIN vulnerabilities and adds the till PIN setup page.
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

Write-Host "Writing app/(app)/layout.tsx"
New-Item -ItemType Directory -Force -Path "app/(app)" | Out-Null
$content = @'
import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { LogoutButton } from "@/components/logout-button";

/**
 * Every route under (app) requires a signed-in user with a linked
 * business profile. This is a convenience redirect for UX — the real
 * security boundary is RLS (every query below this layout is still
 * scoped by Postgres, not by this check) — but without it a
 * signed-out visitor would just see empty states instead of being sent
 * to /login, which is confusing rather than insecure.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    // businesses has two FKs to/from profiles (profiles.business_id ->
    // businesses.id, and businesses.created_by -> profiles.id), so the
    // embed must be disambiguated with the FK constraint name — a bare
    // `businesses (name)` is rejected by PostgREST with PGRST201
    // ("more than one relationship was found"). Confirmed against the
    // real schema; profiles_business_id_fkey is the one we want here.
    .select("id, first_name, last_name, business_id, businesses!profiles_business_id_fkey (name)")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    // A genuine query failure (RLS denial, PostgREST embed error, etc.)
    // looks identical to "no profile yet" if we only check `!profile` —
    // that swallowed real errors during testing and made this
    // undiagnosable. Log it distinctly so the two cases don't get
    // confused again.
    console.error("(app) layout: profiles query failed", profileError);
    redirect("/login");
  }

  if (!profile) {
    // Authenticated but no business/profile link yet (e.g. email
    // confirmation pending, or the register_business() RPC failed after
    // signUp — see app/(auth)/login/actions.ts). Nothing under (app) can
    // render sensibly without a business_id.
    redirect("/login");
  }

  const businessName = (profile as unknown as { businesses: { name: string } | null }).businesses?.name;

  // Cosmetic nav visibility only — every page/action behind these links
  // re-checks the same permission server-side (Section 49).
  const [canManageBranches, canManageBusiness, canViewProducts, canViewInventory, canViewSuppliers, canViewCustomers] =
    await Promise.all([
      hasPermission(supabase, profile.business_id!, PERMISSIONS.BRANCHES_MANAGE),
      hasPermission(supabase, profile.business_id!, PERMISSIONS.BUSINESS_MANAGE),
      hasPermission(supabase, profile.business_id!, PERMISSIONS.PRODUCTS_VIEW),
      hasPermission(supabase, profile.business_id!, PERMISSIONS.INVENTORY_VIEW),
      hasPermission(supabase, profile.business_id!, PERMISSIONS.SUPPLIERS_VIEW),
      hasPermission(supabase, profile.business_id!, PERMISSIONS.CUSTOMERS_VIEW),
    ]);

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="flex flex-col gap-3 border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-brand-600 px-2 py-1 text-sm font-bold text-white">B</span>
          <span className="font-semibold">{businessName ?? "Busihub"}</span>
        </div>
        <nav className="flex items-center gap-4 text-sm font-medium text-neutral-600 dark:text-neutral-300">
          <Link href="/dashboard" className="hover:text-neutral-900 dark:hover:text-white">
            Dashboard
          </Link>
          {canViewProducts ? (
            <Link href="/products" className="hover:text-neutral-900 dark:hover:text-white">
              Products
            </Link>
          ) : null}
          {canViewInventory ? (
            <Link href="/inventory" className="hover:text-neutral-900 dark:hover:text-white">
              Inventory
            </Link>
          ) : null}
          {canViewSuppliers ? (
            <>
              <Link href="/purchase-orders" className="hover:text-neutral-900 dark:hover:text-white">
                Orders
              </Link>
              <Link href="/suppliers" className="hover:text-neutral-900 dark:hover:text-white">
                Suppliers
              </Link>
            </>
          ) : null}
          {canViewCustomers ? (
            <Link href="/customers" className="hover:text-neutral-900 dark:hover:text-white">
              Customers
            </Link>
          ) : null}
          {canManageBranches ? (
            <Link href="/branches" className="hover:text-neutral-900 dark:hover:text-white">
              Branches
            </Link>
          ) : null}
          {canManageBusiness ? (
            <Link href="/settings/business" className="hover:text-neutral-900 dark:hover:text-white">
              Settings
            </Link>
          ) : null}
          {/* Personal, not permissioned — anyone who works a till needs one. */}
          <Link href="/settings/pin" className="hover:text-neutral-900 dark:hover:text-white">
            My PIN
          </Link>
        </nav>
        <div className="flex items-center gap-4">
          <span className="hidden text-sm text-neutral-500 sm:inline">
            {profile.first_name} {profile.last_name}
          </span>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

'@
Set-Content -LiteralPath "app/(app)/layout.tsx" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing app/(app)/settings/pin/actions.ts"
New-Item -ItemType Directory -Force -Path "app/(app)/settings/pin" | Out-Null
$content = @'
"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertValidPinFormat, InvalidPinFormatError } from "@/lib/auth/pin";

export interface PinFormState {
  error?: string;
  success?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Sets the signed-in user's own till PIN.
 *
 * The PIN is sent to set_profile_pin() and hashed inside the database
 * (migration 0018) rather than here: the hash is not readable by any
 * client, so it can never be verified client-side, and keeping both
 * halves in pgcrypto removes any question of two bcrypt implementations
 * agreeing. lib/auth/pin.ts is still the source of the format rule, which
 * is checked here for a fast, friendly error and again in the database
 * because that function is reachable directly.
 */
export async function setOwnPin(_prevState: PinFormState, formData: FormData): Promise<PinFormState> {
  const pin = String(formData.get("pin") ?? "");
  const confirmPin = String(formData.get("confirmPin") ?? "");

  try {
    assertValidPinFormat(pin);
  } catch (err) {
    if (err instanceof InvalidPinFormatError) {
      return { error: err.message, fieldErrors: { pin: err.message } };
    }
    throw err;
  }

  if (pin !== confirmPin) {
    return { error: "The two PINs don't match.", fieldErrors: { confirmPin: "This doesn't match." } };
  }

  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You're not signed in." };
  }

  const { error } = await supabase.rpc("set_profile_pin", { p_profile_id: user.id, p_pin: pin });

  if (error) {
    console.error("setOwnPin: rpc failed", error);
    if (error.code === "22023") {
      return { error: "A PIN must be 4 to 6 digits.", fieldErrors: { pin: "Must be 4 to 6 digits." } };
    }
    return { error: "Couldn't set your PIN. Please try again." };
  }

  revalidatePath("/settings/pin");
  return { success: "Your PIN has been set." };
}

'@
Set-Content -LiteralPath "app/(app)/settings/pin/actions.ts" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing app/(app)/settings/pin/page.tsx"
New-Item -ItemType Directory -Force -Path "app/(app)/settings/pin" | Out-Null
$content = @'
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { PinForm } from "./pin-form";

export const metadata = { title: "Till PIN" };

export default async function PinSettingsPage() {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // pin_set_at is readable; pin_hash deliberately is not (migration 0018).
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, pin_set_at, pin_locked_until")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    console.error("PinSettingsPage: profile query failed", error);
  }

  const hasPin = Boolean(profile?.pin_set_at);
  const lockedUntil = profile?.pin_locked_until ? new Date(profile.pin_locked_until) : null;
  const isLocked = lockedUntil !== null && lockedUntil > new Date();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Till PIN</h1>
        <p className="text-neutral-500">
          A short code that identifies you at a shared till, so each sale records who made it.
        </p>
      </div>

      {isLocked ? (
        <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Your PIN is locked after too many wrong attempts until{" "}
          {lockedUntil.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}. Setting a new PIN below
          unlocks it.
        </p>
      ) : null}

      <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
        4 to 6 digits. It is stored hashed and can never be read back — not by us, not by your colleagues. Five wrong
        attempts locks it for 15 minutes.
        {hasPin ? " You already have a PIN set; entering a new one replaces it." : ""}
      </p>

      <PinForm hasPin={hasPin} />
    </div>
  );
}

'@
Set-Content -LiteralPath "app/(app)/settings/pin/page.tsx" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing app/(app)/settings/pin/pin-form.tsx"
New-Item -ItemType Directory -Force -Path "app/(app)/settings/pin" | Out-Null
$content = @'
"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/button";
import { setOwnPin, type PinFormState } from "./actions";

const initialState: PinFormState = {};

export function PinForm({ hasPin }: { hasPin: boolean }) {
  const [state, formAction] = useFormState(setOwnPin, initialState);

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="rounded-xl bg-green-50 px-3.5 py-2.5 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
          {state.success}
        </p>
      ) : null}

      <Field
        label={hasPin ? "New PIN" : "PIN"}
        name="pin"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        error={state.fieldErrors?.pin}
      />
      <Field
        label="Confirm PIN"
        name="confirmPin"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        error={state.fieldErrors?.confirmPin}
      />

      <SubmitButton pendingText="Saving…" className="mt-2 self-start px-6">
        {hasPin ? "Change PIN" : "Set PIN"}
      </SubmitButton>
    </form>
  );
}

'@
Set-Content -LiteralPath "app/(app)/settings/pin/pin-form.tsx" -Value $content -NoNewline -Encoding UTF8

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

Write-Host "Writing supabase/migrations/0018_pin_security_and_till_login.sql"
New-Item -ItemType Directory -Force -Path "supabase/migrations" | Out-Null
$content = @'
-- Busihub — 0018: PIN security hardening + till login (Phase 9, part 1)
--
-- Phase 2 built the PIN columns and deferred the entry screen to the POS
-- phase. Building that screen meant looking properly at how the columns
-- are protected, and two real holes turned up — both found by querying a
-- live database as a Cashier, not by reading the schema:
--
--   1. ANY colleague could read ANY other profile's pin_hash. profiles'
--      RLS scopes rows to the business, but column privileges are a
--      separate mechanism, and 0009 granted SELECT on every column to
--      `authenticated`. So a cashier could fetch the owner's bcrypt hash
--      straight from PostgREST in the browser. A PIN is 4–6 digits by
--      design; bcrypt at cost 10 does not save a 10^4 keyspace from an
--      offline attack. That is a direct escalation path to whoever
--      authorises discounts, voids and refunds at the till.
--
--   2. A user could reset their OWN pin_failed_attempts and
--      pin_locked_until. The self-update policy on profiles is
--      necessarily permissive, and 0009's escalation guard covered
--      is_super_admin, business_id and pin_hash — but not the lockout
--      counters. The lockout was therefore bypassable by precisely the
--      person being locked out, which is the only person it exists to
--      stop. Verified with a real UPDATE: it reported "UPDATE 1".
--
-- Both are closed below. The design consequence is that the hash never
-- leaves the database at all: hashing AND verification happen here, in
-- SECURITY DEFINER functions, using pgcrypto's crypt() — the same
-- approach Supabase's own auth takes for passwords. Doing the comparison
-- in the database is also what lets a failed attempt increment the
-- counter atomically with the check, rather than in a separate round trip
-- a caller could simply skip.
--
-- Note on the plaintext PIN crossing the wire: it travels inside a TLS
-- request to a parameterised RPC, exactly as a password does to any login
-- endpoint. Do not enable Postgres statement logging with parameter
-- values in production — see docs/SECURITY.md.

-- ── 1. The hash stops being readable by clients ──────────────────────────
--
-- Column-level, because the row is legitimately readable: a cashier needs
-- to see their colleagues' names to pick one at the till. It is only this
-- column they must never see.
--
-- A bare `revoke select (pin_hash)` does NOT work here, and quietly does
-- nothing: 0009 granted table-level SELECT on every table, and in
-- Postgres a table-level privilege authorises every column regardless of
-- any column-level revoke. (Confirmed by trying it — the hash still came
-- back.) The table grant has to go first, then every column EXCEPT the
-- hash is granted back explicitly.
--
-- MAINTENANCE: a future migration that adds a column to profiles must add
-- it to this grant too, or it will be unreadable. That cost is accepted
-- deliberately — the alternative is a readable password-equivalent.
revoke select on profiles from authenticated, anon;

grant select (
  id, business_id, first_name, last_name, display_name, email, phone,
  avatar_url, status, is_super_admin,
  -- pin_hash deliberately absent.
  pin_set_at, pin_failed_attempts, pin_locked_until,
  last_login_at, created_at, updated_at
) on profiles to authenticated;

-- anon reaches no profile row anyway (RLS needs an auth.uid()), but the
-- grant is narrowed to match rather than relying on that alone.
grant select (id, business_id, first_name, last_name, display_name, status) on profiles to anon;

-- The lockout counters stay readable — "is this person locked out?" is
-- not a secret, and the till needs to say so. What matters is that they
-- cannot be WRITTEN by the user they lock out; that is the trigger below,
-- not a grant, because the same table-level-grant rule would defeat a
-- column-level revoke on UPDATE in exactly the same way.

-- ── 2. The lockout counters become tamper-proof ──────────────────────────
--
-- Replaces 0009's version, adding the three PIN columns it did not cover.
-- Same mechanism: these may only change inside a server-side function
-- that explicitly opts in with the busihub.privileged_write flag.
create or replace function prevent_protected_profile_changes()
returns trigger
language plpgsql
as $$
begin
  if (new.is_super_admin is distinct from old.is_super_admin)
     or (new.business_id is distinct from old.business_id)
     or (new.pin_hash is distinct from old.pin_hash)
     or (new.pin_set_at is distinct from old.pin_set_at)
     or (new.pin_failed_attempts is distinct from old.pin_failed_attempts)
     or (new.pin_locked_until is distinct from old.pin_locked_until)
  then
    if coalesce(current_setting('busihub.privileged_write', true), 'off') <> 'on' then
      raise exception 'is_super_admin, business_id and the PIN fields can only be changed by a privileged server-side function'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

comment on function prevent_protected_profile_changes() is
  'Blocks self-service changes to the fields that would let a user escalate: tenancy, super-admin status, the PIN hash, and the PIN lockout counters. The counters were added in 0018 after confirming a user could clear their own lockout.';

-- ── 3. Setting a PIN ─────────────────────────────────────────────────────

create or replace function set_profile_pin(p_profile_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller     uuid := auth.uid();
  v_business   uuid;
  v_target_biz uuid;
begin
  if v_caller is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  -- 4–6 digits. Checked here as well as in the app, because this function
  -- is reachable directly and a 2-digit PIN would be a real weakening.
  if p_pin !~ '^\d{4,6}$' then
    raise exception 'A PIN must be 4 to 6 digits' using errcode = '22023';
  end if;

  select business_id into v_business from profiles where id = v_caller;
  select business_id into v_target_biz from profiles where id = p_profile_id;

  if v_target_biz is null or v_business is null or v_target_biz <> v_business then
    raise exception 'That user could not be found' using errcode = 'P0002';
  end if;

  -- Your own PIN is yours to set. Setting somebody else's is staff
  -- administration and needs users.manage.
  if p_profile_id <> v_caller
     and not (app_has_permission(v_business, 'users.manage') or app_is_super_admin()) then
    raise exception 'Missing permission: users.manage' using errcode = '42501';
  end if;

  perform set_config('busihub.privileged_write', 'on', true);

  update profiles
  set pin_hash            = crypt(p_pin, gen_salt('bf', 10)),
      pin_set_at          = now(),
      pin_failed_attempts = 0,
      pin_locked_until    = null
  where id = p_profile_id;

  perform set_config('busihub.privileged_write', 'off', true);
end;
$$;

grant execute on function set_profile_pin(uuid, text) to authenticated;

comment on function set_profile_pin(uuid, text) is
  'Sets a cashier PIN. Hashes with pgcrypto inside the database so the plaintext is never stored and the hash never has to be read back out. Own PIN always allowed; another user''s requires users.manage.';

-- ── 4. Verifying a PIN ───────────────────────────────────────────────────
--
-- Returns a plain boolean. The hash is compared in here, so no caller
-- ever holds it; and because the failure counter is incremented in the
-- same call, an attacker cannot simply decline to report their failures.
create or replace function verify_profile_pin(p_profile_id uuid, p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller   uuid := auth.uid();
  v_business uuid;
  v_profile  profiles%rowtype;
  v_ok       boolean;
begin
  if v_caller is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  select business_id into v_business from profiles where id = v_caller;
  select * into v_profile from profiles where id = p_profile_id;

  -- Same business, or nothing. Deliberately the same error for "no such
  -- user" and "another tenant's user", so this cannot be used to probe
  -- which profile ids exist elsewhere.
  if v_profile.id is null or v_business is null or v_profile.business_id <> v_business then
    raise exception 'That user could not be found' using errcode = 'P0002';
  end if;

  if v_profile.status <> 'active' then
    raise exception 'That user is not active' using errcode = 'P0001';
  end if;

  if v_profile.pin_locked_until is not null and v_profile.pin_locked_until > now() then
    raise exception 'Too many wrong attempts. Try again after %',
      to_char(v_profile.pin_locked_until, 'HH24:MI')
      using errcode = 'P0001';
  end if;

  if v_profile.pin_hash is null then
    raise exception 'That user has no PIN set' using errcode = 'P0001';
  end if;

  v_ok := (crypt(p_pin, v_profile.pin_hash) = v_profile.pin_hash);

  perform set_config('busihub.privileged_write', 'on', true);

  if v_ok then
    update profiles
    set pin_failed_attempts = 0, pin_locked_until = null, last_login_at = now()
    where id = p_profile_id;
  else
    update profiles
    set pin_failed_attempts = pin_failed_attempts + 1,
        -- Threshold and duration mirror lib/auth/pin.ts's constants.
        pin_locked_until = case
          when pin_failed_attempts + 1 >= 5 then now() + interval '15 minutes'
          else pin_locked_until
        end
    where id = p_profile_id;
  end if;

  perform set_config('busihub.privileged_write', 'off', true);

  return v_ok;
end;
$$;

grant execute on function verify_profile_pin(uuid, text) to authenticated;

comment on function verify_profile_pin(uuid, text) is
  'Verifies a cashier PIN entirely inside the database and maintains the lockout counters in the same call. Returns true/false; raises only for conditions the user needs told about (locked out, no PIN set, inactive).';

-- ── 5. Who can be picked at the till ─────────────────────────────────────
--
-- pin_set_at is deliberately NOT revoked above: "does this colleague have
-- a PIN?" is not a secret, and exposing it means the till picker is an
-- ordinary RLS-scoped select rather than another privileged function.
comment on column profiles.pin_set_at is
  'When the PIN was last set. Readable by colleagues (unlike pin_hash) so the till can list who is able to sign in.';

'@
Set-Content -LiteralPath "supabase/migrations/0018_pin_security_and_till_login.sql" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing tests/security/pin.sql"
New-Item -ItemType Directory -Force -Path "tests/security" | Out-Null
$content = @'
-- Busihub — security test for cashier PINs (migration 0018).
--
-- These cover two holes that were real and reachable before 0018, both
-- found by querying a live database as a Cashier rather than by reading
-- the schema:
--   1. any colleague could SELECT another profile's pin_hash;
--   2. a user could clear their own PIN lockout counters.
-- Tests 1 and 4 fail against the pre-0018 schema.
--
-- Run against a throwaway Postgres loaded with
-- tests/db-harness/00_stub_supabase.sql + supabase/migrations/*.sql +
-- supabase/seed.sql.
--
-- `TEST FAILED` raises use SQLSTATE ZZ999, which no handler here catches
-- (the default, P0001, is caught below as an *expected* rejection).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures: a Cashier (no users.manage) alongside the seeded Owner ─────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000099',
        'authenticated', 'authenticated', 'cashier@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

do $$
declare v_biz uuid; v_branch uuid; v_role uuid;
begin
  select id into v_biz from businesses where slug = 'busihub-demo-store';
  select id into v_branch from branches where business_id = v_biz and is_main;
  select id into v_role from roles where business_id = v_biz and name = 'Cashier';

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000099', v_biz, 'Demo', 'Cashier', 'cashier@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000000099', v_role,
            '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;

  if exists (
    select 1 from role_permissions rp join permissions p on p.id = rp.permission_id
    where rp.role_id = v_role and p.key = 'users.manage'
  ) then
    raise exception 'TEST FIXTURE BROKEN: Cashier unexpectedly holds users.manage' using errcode = 'ZZ999';
  end if;
end $$;

-- Both users get a PIN, set through the real function.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select set_profile_pin('00000000-0000-0000-0000-000000000001', '4821');
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000099';
select set_profile_pin('00000000-0000-0000-0000-000000000099', '1357');
reset role;
reset request.jwt.claim.sub;

-- ── 1. The hash is not readable by a colleague ───────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000099';

do $$
declare v_hash text;
begin
  begin
    select pin_hash into v_hash from profiles where id = '00000000-0000-0000-0000-000000000001';
    raise exception 'TEST FAILED: cashier read the owner''s pin_hash (%)', left(coalesce(v_hash, 'null'), 12)
      using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: pin_hash is not readable by a colleague';
  end;

  -- ...not even one's own, since nothing legitimate needs it client-side.
  begin
    select pin_hash into v_hash from profiles where id = '00000000-0000-0000-0000-000000000099';
    raise exception 'TEST FAILED: a user read their own pin_hash' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: pin_hash is not readable even by its owner';
  end;
end $$;

-- ── 2. Everything the application actually reads still works ─────────────
-- Narrowing a grant is exactly the kind of fix that breaks unrelated
-- pages, so the real queries are asserted rather than assumed.

do $$
declare v_name text; v_has_pin boolean; v_count int;
begin
  -- The (app) layout.
  select first_name into v_name from profiles where id = '00000000-0000-0000-0000-000000000099';
  if v_name is null then
    raise exception 'TEST FAILED: the layout''s profile query stopped working' using errcode = 'ZZ999';
  end if;

  -- The till picker: who has a PIN, without seeing any hash.
  select count(*) into v_count from profiles where pin_set_at is not null;
  if v_count < 2 then
    raise exception 'TEST FAILED: expected 2 profiles with a PIN, saw %', v_count using errcode = 'ZZ999';
  end if;

  select pin_set_at is not null into v_has_pin from profiles where id = '00000000-0000-0000-0000-000000000001';
  if not v_has_pin then
    raise exception 'TEST FAILED: cannot tell whether a colleague has a PIN' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: names, and "has a PIN", remain readable — only the hash is hidden';
end $$;

-- ── 3. Verification works, and is wrong when it should be ────────────────

do $$
begin
  if not verify_profile_pin('00000000-0000-0000-0000-000000000099', '1357') then
    raise exception 'TEST FAILED: the correct PIN did not verify' using errcode = 'ZZ999';
  end if;
  if verify_profile_pin('00000000-0000-0000-0000-000000000099', '9999') then
    raise exception 'TEST FAILED: a wrong PIN verified' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: correct PIN verifies, wrong PIN does not';

  -- A cashier can verify a colleague's PIN — that IS the till flow (the
  -- device is signed in as somebody; the PIN says who is at the counter).
  -- Knowing the PIN is the secret, and it is never exposed.
  if not verify_profile_pin('00000000-0000-0000-0000-000000000001', '4821') then
    raise exception 'TEST FAILED: could not verify a colleague''s PIN at the till' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a colleague''s PIN can be verified at a shared till';
end $$;

-- ── 4. The lockout cannot be cleared by the person it locks out ──────────

do $$
declare v_attempts int; v_locked timestamptz; v_rows int;
begin
  -- Enough wrong attempts to lock the account. Once it locks, further
  -- calls raise rather than return false, so the raise is swallowed here:
  -- the point of the loop is only to reach the locked state (the exact
  -- attempt it happens on depends on what earlier tests left behind).
  for i in 1..6 loop
    begin
      perform verify_profile_pin('00000000-0000-0000-0000-000000000099', '0000');
    exception when sqlstate 'P0001' then
      null; -- already locked
    end;
  end loop;

  select pin_failed_attempts, pin_locked_until into v_attempts, v_locked
  from profiles where id = '00000000-0000-0000-0000-000000000099';

  if v_attempts < 5 then
    raise exception 'TEST FAILED: failed attempts not counted (got %)', v_attempts using errcode = 'ZZ999';
  end if;
  if v_locked is null or v_locked <= now() then
    raise exception 'TEST FAILED: account not locked after 5 wrong attempts' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: 5 wrong attempts locks the account until %', to_char(v_locked, 'HH24:MI');

  -- The whole point: the locked-out user cannot clear it themselves.
  -- An RLS-denied UPDATE would silently match 0 rows, so this asserts the
  -- data — but here the trigger raises outright, which is stronger.
  begin
    update profiles set pin_failed_attempts = 0, pin_locked_until = null
    where id = '00000000-0000-0000-0000-000000000099';
    get diagnostics v_rows = row_count;
    raise exception 'TEST FAILED: the locked-out user cleared their own lockout (% row(s))', v_rows
      using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: a user cannot clear their own PIN lockout';
  end;

  select pin_locked_until into v_locked from profiles where id = '00000000-0000-0000-0000-000000000099';
  if v_locked is null then
    raise exception 'TEST FAILED: the lockout was cleared anyway' using errcode = 'ZZ999';
  end if;

  -- And while locked, even the RIGHT PIN is refused.
  begin
    perform verify_profile_pin('00000000-0000-0000-0000-000000000099', '1357');
    raise exception 'TEST FAILED: a locked account accepted the correct PIN' using errcode = 'ZZ999';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: while locked, even the correct PIN is refused';
  end;
end $$;

-- ── 5. Setting somebody else's PIN needs users.manage ────────────────────

do $$
begin
  begin
    perform set_profile_pin('00000000-0000-0000-0000-000000000001', '2468');
    raise exception 'TEST FAILED: a cashier set the owner''s PIN' using errcode = 'ZZ999';
  exception when insufficient_privilege then
    raise notice 'PASS: setting another user''s PIN requires users.manage';
  end;

  -- Their own is fine, and it clears the lockout as a side effect —
  -- which is how a manager resets a locked-out cashier.
  perform set_profile_pin('00000000-0000-0000-0000-000000000099', '2468');
  if not verify_profile_pin('00000000-0000-0000-0000-000000000099', '2468') then
    raise exception 'TEST FAILED: newly set PIN does not verify' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a user can set their own PIN, and doing so clears the lockout';
end $$;

-- ── 6. A weak PIN is refused even calling the function directly ──────────

do $$
declare v_pin text;
begin
  foreach v_pin in array array['12', '123', '1234567', 'abcd', '', '12a4', '1 34'] loop
    begin
      perform set_profile_pin('00000000-0000-0000-0000-000000000099', v_pin);
      raise exception 'TEST FAILED: a PIN of "%" was accepted', v_pin using errcode = 'ZZ999';
    exception when sqlstate '22023' then
      null; -- expected
    end;
  end loop;
  raise notice 'PASS: PINs outside 4-6 digits are refused by the function itself';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 7. Cross-tenant: another business's PIN is not verifiable ────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000045',
        'authenticated', 'authenticated', 'ownere@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000045';
select register_business('PIN Test Shop E', 'Nana', 'Yaw');

do $$
begin
  begin
    perform verify_profile_pin('00000000-0000-0000-0000-000000000099', '2468');
    raise exception 'TEST FAILED: verified another business''s PIN' using errcode = 'ZZ999';
  exception when sqlstate 'P0002' then
    raise notice 'PASS: another business''s PIN is not verifiable (reported as not found)';
  end;

  begin
    perform set_profile_pin('00000000-0000-0000-0000-000000000099', '1111');
    raise exception 'TEST FAILED: set another business''s PIN' using errcode = 'ZZ999';
  exception when sqlstate 'P0002' then
    raise notice 'PASS: another business''s PIN cannot be set';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

\echo ''
\echo 'All PIN security tests passed.'

'@
Set-Content -LiteralPath "tests/security/pin.sql" -Value $content -NoNewline -Encoding UTF8

Write-Host ""
Write-Host "Done. 8 files written." -ForegroundColor Green
Write-Host ""
Write-Host "Next: npm run db:migrate   (applies migration 0018)" -ForegroundColor Yellow
Write-Host "Then: npm run typecheck; npm run lint; npm run test; npm run build" -ForegroundColor Yellow
