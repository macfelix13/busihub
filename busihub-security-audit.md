# Busihub Security Audit

**Scope:** full codebase at `origin/main` (commit `7d8b946`), audited against the project's standing security constraints and the "Development phases" roadmap in `docs/ARCHITECTURE.md`. This corresponds to that roadmap's own Phase 22, "Security review pass," which was still marked `pending`.

**Method:** five independent, file-and-line-level passes over the real code and SQL migrations — tenant isolation/RLS, client-trust boundaries, secrets/error-handling/hardcoded IDs, payment/webhook/rate-limiting/file-uploads, and audit-log coverage/privilege boundaries. Nothing here is taken from documentation claims alone; every verdict below cites the actual file. `docs/ARCHITECTURE.md` and `docs/SECURITY.md` were found to be stale in places and were not trusted at face value.

## Verdict against the standing constraints

| Constraint | Verdict | Notes |
|---|---|---|
| Never rely only on frontend hiding to enforce permissions | **Pass** | Every permission check re-verified server-side via `hasPermission()`/RLS; two `/admin` pages lean on their layout's guard rather than re-checking themselves, but RLS backstops them regardless (Gap #10). |
| A user must never reach data by manipulating URLs/IDs/params | **Pass, with one caveat** | Cross-tenant access is fully blocked. Cross-**branch** access within the same business is not enforced (Gap #3) — see below. |
| Do not trust client-side payment status | **Pass** | Payment success/failure is only ever written by `settle_sale_payment()`, callable only by `service_role`, only from a signature-verified webhook or a server-to-Paystack verify call. |
| Never trust business/user/branch IDs, prices, payment status, or permissions supplied by the client | **Pass** | Zero counterexamples found across 11+ actions files. Prices are always looked up server-side from `product_variants`; identity is always derived from `auth.uid()`. |
| Business A must never access Business B's data | **Pass, with one test gap** | All 34 tenant tables have RLS scoped correctly. `products`/`product_variants` lack a direct cross-tenant denial test (Gap #4) — coverage is only indirect. |
| Do not expose raw DB errors, stack traces, secrets, or internal details | **Pass** | Consistent, deliberate pattern: real errors go to `console.error`, only hand-written or generic messages reach the client. No counterexample found in 12 sampled files. |
| Do not hardcode business/user/branch IDs | **Pass** | Zero hardcoded IDs in application code (test fixtures and seed data correctly excluded from this rule). |
| Keep the architecture modular enough to migrate off Supabase/Vercel | **Not directly re-audited this pass** | Out of scope for a security review; worth its own architectural pass. Worth flagging as an inherent tension: much of the security model (RLS, `SECURITY DEFINER` functions) is genuinely Postgres/Supabase-specific by design, which is also *why* it's this solid — a future migration would need to re-implement that layer deliberately, not just swap a client library. |

## Gaps found, ranked

**1. High — No rate limiting or lockout on password login, the till's "switch user" sign-in, or password-reset requests.**
`app/(auth)/login/actions.ts`, `app/(app)/till/actions.ts` (`switchTillUser`), and `app/(auth)/reset-password/actions.ts` all call Supabase Auth directly with no attempt counter, delay, or lockout. Unlimited password-guessing against a known email is possible from the app's own code today; the only backstop is whatever Supabase's platform-level default is, which isn't configured or visible anywhere in this repo. PIN entry (the till's own second factor) *is* properly protected — a DB-enforced 5-attempts/15-minute lockout (`verify_profile_pin()`, migration `0039`) — but that only matters after a real login has already succeeded. This is the one item I'd call launch-blocking; `docs/SECURITY.md` already flags it as needed before launch, and that's still accurate.

**2. High — Refunds and voids are not audit-logged.**
`void_sale` and `create_refund` (migration `0021`, `0038`) never call `log_audit_event()`. Given every other sensitive action (staff changes, payment settings, super admin actions) *is* logged, this is a specific and meaningful gap — refunds/voids are the classic point-of-sale fraud vector, and right now there's no audit trail of who reversed a sale or when.

**3. Medium — Branch-level permission scoping is defined but never enforced.**
`app_has_branch_permission()`/`requireBranchPermission()` exist and are fully implemented, but are never actually called from any Server Action or RLS policy — every permission check in the app is business-wide only. A staff member with a role at only one branch can currently ring up sales, receive stock, or record expenses "at" a different branch of the *same* business by supplying that branch's id, even though the schema (`user_branch_roles.branch_id`) implies branch-specific assignment should matter. This never crosses the tenant boundary, but it's a real gap against the finer-grained model the schema supports.

**4. Medium — `products`/`product_variants` lack a direct cross-tenant denial test.**
The RLS policy itself is correctly scoped (`business_id = app_current_business_id()`); what's missing is a standalone test asserting a second business sees zero rows, the way `tests/security/customers.sql` and `sales.sql` already do. Coverage today is only indirect (via inventory-receiving and sale-creation tests).

**5. Medium — Several more sensitive actions aren't audit-logged:** expense voiding (`void_expense`), customer credit-limit changes (`updateCustomer`), branch create/edit, and general business-settings changes. None of these are wired to `log_audit_event()` today.

**6. Medium — the "discount cap" feature appears to be schema-only, not enforced.**
`discounts.apply` / `discounts.apply.unlimited` permissions and a `default_discount_cap_percent` setting exist, but no code path in the till or sale-creation logic actually applies or caps a discount at checkout — the feature looks dormant rather than built. **This directly affects the landing page I just shipped**, which currently says "Discounts with a cap you control" and "A discount cap so cashiers can't discount without limit." That's exactly the kind of claim the project's own "do not fake completion" rule exists to catch, and this audit is what caught it. I'd like your go-ahead to pull those two lines from the landing page now, or confirm if there's discount-cap logic elsewhere I didn't find — let me know which.

**7. Low — CSP allows `'unsafe-inline'` on `script-src`/`style-src`.**
Already self-documented in `docs/SECURITY.md` as a known pre-launch item; still shipped. Weakens (doesn't eliminate) the CSP's value against injected-script XSS.

**8. Low — `lib/supabase/server.ts`/`lib/supabase/env.ts` lack the explicit `import "server-only"` guard** that `secret-box.ts` and `paystack/client.ts` have, despite doc-comments saying "server only." Not currently exploitable (non-`NEXT_PUBLIC_` env vars aren't bundled to the browser regardless), but inconsistent with the stronger pattern used elsewhere.

**9. Low — documentation hygiene, three instances:**
- `lib/auth/pin.ts` references a `lib/auth/rate-limit.ts` file that doesn't exist — stale comment, could mislead a future reader into thinking more coverage exists than does.
- The audit-log page's `ACTION_LABELS` map only covers 8 of the 17 real action types in use — the other 9 still log and display correctly, just as a raw string instead of a friendly label.
- `docs/ARCHITECTURE.md`'s phase table marks Phase 19 (Super Admin) and Phase 20 (Audit surfaces) as "pending" — both are actually substantially built (a full `/admin` console with layout guard + RLS backstop + audit logging; 17 audited action types end-to-end). The table should be corrected so it stops understating what's actually shipped.

**10. Informational — two `/admin` pages rely solely on their layout's guard rather than each independently re-checking `isSuperAdmin()`,** contrary to the layout's own comment describing that as the convention. Not exploitable — the `businesses_update` RLS policy independently requires `app_is_super_admin()` regardless — but worth tidying for consistency.

**11. Informational — `lib/env.ts` hardcodes a real personal email and phone number** as a fallback support contact. Not a credential, but it is real PII shipped in a public repo; worth the team's conscious awareness rather than an accident.

## What's genuinely solid (no gaps found)

- **Tenant isolation**: all 34 business-scoped tables have RLS enabled and correctly scoped; the two `using (true)` policies found are on genuinely global catalog tables with no tenant column, not a gap.
- **Client-trust boundaries**: zero counterexamples across till, sales, products, inventory, customers, expenses, purchase-orders, branches, staff, payments, reports export, and admin — identity and pricing are always server-derived.
- **Paystack webhook security**: HMAC verified over the raw body with the correct business's own key, idempotent via a primary-key guard, cross-tenant settlement blocked at the database layer, and a guessed webhook URL gains nothing without a valid signature.
- **File uploads**: private storage buckets, MIME/size allow-lists enforced at the storage layer (not just the client), RLS scoping by business id folder, and time-limited signed URLs rather than public paths.
- **SQL injection / input validation**: zod validation server-side on every sampled mutation; zero instances of hand-built SQL strings anywhere in the codebase.
- **Error handling**: one consistent, deliberate convention — real errors logged server-side, only safe/generic or hand-written messages ever reach a user.
- **Hardcoded IDs**: none found in application code.
- **Super admin boundary**: `is_super_admin` has no user-reachable path to being set (only a `revoke`d, DB-console-only bootstrap function), and a protective trigger blocks a user from changing it on their own profile even by other means.
- **Staff privilege escalation**: promoting someone to Owner requires an extra `business.manage` check beyond ordinary staff management, nobody can act on their own account through these paths, and the last remaining Owner of a business cannot be demoted or deactivated.

## Recommended next steps, roughly in priority order

1. Add app-level rate limiting/lockout to login, till "switch user," and password-reset (Gap #1) — this is the one item I'd treat as blocking before a real public launch.
2. Wire `log_audit_event()` into `void_sale`, `create_refund`, `void_expense`, `updateCustomer`'s credit-limit path, and branch/business-settings changes (Gaps #2, #5).
3. Decide on the discount-cap feature (Gap #6): implement it for real, or adjust the landing page and staff-facing copy to stop claiming it exists.
4. Add the missing `products` cross-tenant test (Gap #4) and either wire up branch-level permission enforcement or explicitly document that branch id is a data-scoping value only, not an authorization boundary (Gap #3).
5. The CSP/`server-only` items (Gaps #7–8) and documentation cleanups (Gap #9) are good hygiene whenever there's a quiet moment, not urgent.

None of the "Pass" verdicts above should be read as "perfect forever" — they're accurate as of commit `7d8b946`. Re-running a pass like this after major changes (especially to payments, staff/roles, or anything touching RLS) is worth doing again rather than assuming it still holds.
