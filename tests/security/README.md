# Security tests: tenant isolation & RBAC

`tenant_isolation_and_rbac.sql` exercises the real Postgres RLS policies
and permission-check functions directly — not through the Next.js
application layer — so these guarantees hold even if application code has
a bug. It covers:

- Cross-tenant isolation (a business owner cannot read another business's rows)
- `register_business()` end-to-end as a real authenticated session
- RBAC enforcement (`Cashier` blocked from a `roles.manage`-gated write, permission resolution correct)
- Privilege-escalation resistance (`profiles.is_super_admin` / `business_id` cannot be self-updated)
- `anon` isolation (no tenant data; public plan catalog still readable)

It fails loudly (`TEST FAILED` → non-zero psql exit code) if any guarantee
doesn't hold, so it's safe to wire into CI as a pass/fail gate — see
`.github/workflows/ci.yml`, job `database`.

## Running locally

Requires a local Postgres (this does **not** need a Supabase project —
`tests/db-harness/00_stub_supabase.sql` stubs just enough of Supabase's
`auth` schema and roles to apply the real migrations against plain
Postgres).

```bash
createdb busihub_test
psql -d busihub_test -v ON_ERROR_STOP=1 -f tests/db-harness/00_stub_supabase.sql
for f in supabase/migrations/*.sql; do
  psql -d busihub_test -v ON_ERROR_STOP=1 -f "$f"
done
psql -d busihub_test -v ON_ERROR_STOP=1 -f supabase/seed.sql
psql -d busihub_test -f tests/security/tenant_isolation_and_rbac.sql
```

This exact sequence has been run in this repo's development (see git log)
against a local PostgreSQL 16 instance — all migrations apply cleanly and
every assertion in the test file passes.
