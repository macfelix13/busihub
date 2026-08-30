# Busihub — Security

## Verified, not assumed

`tests/security/tenant_isolation_and_rbac.sql` runs the following directly
against Postgres (not through the app layer) and is wired into CI
(`.github/workflows/ci.yml`, job `database`) as a pass/fail gate:

- Cross-tenant isolation: a business owner cannot read another business's `businesses`/`branches` rows.
- `register_business()` behaves correctly under a real authenticated session.
- A Cashier is blocked, at the database layer, from a `roles.manage`-gated write.
- Permission resolution (`app_has_permission`) matches the seeded role templates.
- `profiles.is_super_admin` and `profiles.business_id` cannot be changed by a user updating their own row, even though the general "update your own profile" policy is otherwise permissive.
- `anon` (no session) cannot read any tenant data but can read the public subscription plan catalog.

This suite was run against a local PostgreSQL 16 instance during
development (all migrations apply cleanly, every assertion passes) and
runs again on every push via CI.

## Secrets

`SUPABASE_SERVICE_ROLE_KEY`, `PAYSTACK_KEY_ENCRYPTION_KEY`, and
`PIN_SESSION_SECRET` are server-only environment variables — grep the
codebase for `NEXT_PUBLIC_` if you need to confirm what's actually shipped
to the browser; nothing else is. `.env.example` documents every variable
with a placeholder; no real value has ever been committed (`.gitignore`
excludes `.env*` except `.env.example`).

There is deliberately **no** platform Paystack key. Each business connects
its own Paystack account (Settings → Payments), so payments settle to that
shop and Busihub never holds anyone's money. That makes each shop's
Paystack *secret key* the most dangerous value this system stores — it can
move real money out of a real account — and it is handled accordingly:

- Encrypted with AES-256-GCM in the application (`lib/crypto/secret-box.ts`)
  before it reaches the database, under `PAYSTACK_KEY_ENCRYPTION_KEY`,
  which is never written to the database. A dump of
  `business_payment_settings` alone decrypts to nothing.
- GCM rather than CBC, so a tampered ciphertext fails to decrypt instead
  of quietly producing different plaintext.
- The ciphertext column is not selectable by `authenticated` at all
  (migration 0022, revoke-table-then-grant-per-column — the same pattern
  that closed the `pin_hash` leak in 0018). Only the server, using the
  service-role client, ever reads it. The owner sees the last four
  characters, enough to recognise which key is installed.
- Rotating `PAYSTACK_KEY_ENCRYPTION_KEY` makes every stored secret
  undecryptable by design; each shop must paste its key in again.

Webhooks are verified as HMAC-SHA512 over the **raw** request body under
the shop's own secret key, with a timing-safe comparison. The endpoint is
per business (`/api/webhooks/paystack/[businessId]`) because there is no
single key to verify against — and because a verified signature proves
only *which business* is calling, the business id is passed down to
`settle_sale_payment()`, which refuses a payment belonging to anyone else.

## Known gaps (foundation phase) — tracked, not hidden

Per Section 52 of the brief ("do not claim a feature works if it has not
been verified"), here is what a "production readiness" pass still needs
before real money moves through this system:

- **Application-level rate limiting.** Supabase Auth's built-in throttling covers the auth endpoints; login/PIN-entry/password-reset don't yet have an additional app-level limiter (e.g. Upstash Ratelimit). Needed before production launch.
- **CSP `script-src`/`style-src` currently allow `'unsafe-inline'`** (`next.config.mjs`) because Next.js's default inline bootstrap script and Tailwind's injected styles need it in dev. Tightening this to a nonce-based policy is a pre-launch task, not done here because it needs to be verified against an actual build output, which this sandbox cannot produce (see `docs/DEPLOYMENT.md`).
- **MFA, phone auth, Google OAuth** are supported by Supabase Auth but not yet wired into the Busihub UI (`docs/AUTH.md`).
- **Security headers, RLS, and the tenant-isolation tests above** have been verified against a local Postgres instance standing in for Supabase (`tests/db-harness/00_stub_supabase.sql`) — not yet against a real Supabase project, Vercel deployment, or over real HTTPS with the headers actually observed in a response. That verification is the first thing to do once a real Supabase project and Vercel deployment exist (`docs/DEPLOYMENT.md`).
- **Dependency versions**: the initial hand-pinned set (Next 14.2.15 and contemporaries) turned out to have several known advisories, including a critical Next.js one — `npm install` followed by `npm audit fix --force` (run on a real machine, not this sandbox) upgraded to Next 16.3.3, ESLint 9 (flat config — see `eslint.config.mjs`), and current patched versions of `@supabase/*`, `vitest`, `@playwright/test`, and `postcss`, bringing `npm audit` down to a single moderate/high pair (`esbuild`, a dev-only transitive dependency of `vitest`'s Vite tooling — not present in the production build, low priority to chase further). `react`/`react-dom` were deliberately left at 18.3.1 pending confirmation that Next 16 doesn't hard-require React 19 (`npm ls react next` should be checked after a clean install — if Next 16 pulls React 19 itself, no code change is needed on our side: `useFormState` is kept as a deprecated-but-functional alias in React 19's `react-dom`, and every Server Component `cookies()`/`headers()` call already uses `await`, which is the Next 15+/React 19-required form and also works unchanged under Next 14/React 18).

## Reporting a vulnerability

There is no public bug bounty yet. Report suspected issues directly to the
project owner rather than opening a public GitHub issue.
