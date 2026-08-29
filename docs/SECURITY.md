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

`SUPABASE_SERVICE_ROLE_KEY`, `PAYSTACK_SECRET_KEY`, and `PIN_SESSION_SECRET`
are server-only environment variables — grep the codebase for
`NEXT_PUBLIC_` if you need to confirm what's actually shipped to the
browser; nothing else is. `.env.example` documents every variable with a
placeholder; no real value has ever been committed (`.gitignore` excludes
`.env*` except `.env.example`).

## Known gaps (foundation phase) — tracked, not hidden

Per Section 52 of the brief ("do not claim a feature works if it has not
been verified"), here is what a "production readiness" pass still needs
before real money moves through this system:

- **Application-level rate limiting.** Supabase Auth's built-in throttling covers the auth endpoints; login/PIN-entry/password-reset don't yet have an additional app-level limiter (e.g. Upstash Ratelimit). Needed before production launch.
- **CSP `script-src`/`style-src` currently allow `'unsafe-inline'`** (`next.config.mjs`) because Next.js's default inline bootstrap script and Tailwind's injected styles need it in dev. Tightening this to a nonce-based policy is a pre-launch task, not done here because it needs to be verified against an actual build output, which this sandbox cannot produce (see `docs/DEPLOYMENT.md`).
- **MFA, phone auth, Google OAuth** are supported by Supabase Auth but not yet wired into the Busihub UI (`docs/AUTH.md`).
- **Security headers, RLS, and the tenant-isolation tests above** have been verified against a local Postgres instance standing in for Supabase (`tests/db-harness/00_stub_supabase.sql`) — not yet against a real Supabase project, Vercel deployment, or over real HTTPS with the headers actually observed in a response. That verification is the first thing to do once a real Supabase project and Vercel deployment exist (`docs/DEPLOYMENT.md`).
- **Dependency versions in `package.json` were hand-pinned** to versions believed current and mutually compatible at the time of writing, but `npm install` has not been run in this environment (its network is locked to a handful of hosts and blocks the npm registry — see `docs/DEPLOYMENT.md`). Run `npm install` and resolve anything `npm audit`/a peer-dependency warning flags before deploying.

## Reporting a vulnerability

There is no public bug bounty yet. Report suspected issues directly to the
project owner rather than opening a public GitHub issue.
