# Busihub — Security review, 2026-09

Corresponds to `docs/ARCHITECTURE.md`'s Phase 22, "Security review pass."

**Scope:** full codebase as of commit `7d8b946`, audited against the
project's standing security constraints (see the top of `docs/SECURITY.md`
and the brief) and the "Development phases" roadmap. **Method:** five
independent, file-and-line-level passes over the real code and SQL
migrations — tenant isolation/RLS, client-trust boundaries, secrets/
error-handling/hardcoded IDs, payment/webhook/rate-limiting/file-uploads,
and audit-log coverage/privilege boundaries. Nothing here was taken from
documentation claims alone; every verdict cites the actual file.
`docs/ARCHITECTURE.md` and `docs/SECURITY.md` were found to be stale in a
couple of places at the time and were not trusted at face value (both were
corrected as part of this pass).

This document records the findings AND what happened to each of them —
several were fixed in the same pass (migrations `0048`/`0049` and the
`app/**/actions.ts` changes alongside them); a couple are deliberately left
open because they are product/scope decisions, not bug fixes.

## Verdict against the standing constraints

| Constraint | Verdict | Notes |
|---|---|---|
| Never rely only on frontend hiding to enforce permissions | **Pass** | Every permission check re-verified server-side via `hasPermission()`/RLS; two `/admin` pages lean on their layout's guard rather than re-checking themselves, but RLS backstops them regardless (Item #10). |
| A user must never reach data by manipulating URLs/IDs/params | **Pass, with one caveat** | Cross-tenant access is fully blocked. Cross-**branch** access within the same business is not enforced (Item #3, still open — see below). |
| Do not trust client-side payment status | **Pass** | Payment success/failure is only ever written by `settle_sale_payment()`, callable only by `service_role`, only from a signature-verified webhook or a server-to-Paystack verify call. |
| Never trust business/user/branch IDs, prices, payment status, or permissions supplied by the client | **Pass** | Zero counterexamples found across 11+ actions files. Prices are always looked up server-side from `product_variants`; identity is always derived from `auth.uid()`. |
| Business A must never access Business B's data | **Pass** | All 34 tenant tables have RLS scoped correctly. `products`/`product_variants` previously had only indirect test coverage — fixed, see Item #4. |
| Do not expose raw DB errors, stack traces, secrets, or internal details | **Pass** | Consistent, deliberate pattern: real errors go to `console.error`, only hand-written or generic messages reach the client. |
| Do not hardcode business/user/branch IDs | **Pass** | Zero hardcoded IDs in application code (test fixtures and seed data correctly excluded). |
| Keep the architecture modular enough to migrate off Supabase/Vercel | **Not directly re-audited this pass** | Out of scope for a security review; worth its own architectural pass. Much of the security model (RLS, `SECURITY DEFINER` functions) is genuinely Postgres/Supabase-specific by design — which is also *why* it's this solid. |

## Findings and their status

**1. [High] No rate limiting or lockout on password login, the till's "switch user" sign-in, or password-reset requests. → FIXED.**
`app/(auth)/login/actions.ts`, `app/(app)/till/actions.ts` (`switchTillUser`),
and `app/(auth)/reset-password/actions.ts` called Supabase Auth directly
with no attempt counter, delay, or lockout — unlimited password-guessing
against a known email was possible from the app's own code. Fixed by
migration `0048_auth_rate_limiting.sql` (`auth_rate_limit_check`/
`auth_rate_limit_record`, the same DB-enforced-lockout shape as cashier
PIN entry, 0039) and `lib/auth/rate-limit.ts`, wired into all three call
sites: 8 failed attempts / 15-minute lockout for real sign-ins, a
3-request/15-minute limiter for reset requests (which can't use success/
failure, since that endpoint must never reveal whether an email exists).

**2. [High] Refunds and voids were not audit-logged. → FIXED.**
`void_sale()` and `create_refund()` never called `log_audit_event()`,
despite every other sensitive action (staff changes, payment settings,
Super Admin actions) doing so — a specific, meaningful gap, since
refunds/voids are the classic point-of-sale fraud vector. Fixed by
migration `0049_audit_log_gaps.sql`: both functions now write a
`sale.voided` / `sale.refunded` row, in the same transaction as the
reversal, alongside the notification each already wrote.

**3. [Medium] Branch-level permission scoping is defined but never enforced. → OPEN — needs a product decision.**
`app_has_branch_permission()`/`requireBranchPermission()` exist and are
fully implemented, but are never called from any Server Action or RLS
policy — every permission check in the app is business-wide only. A staff
member with a role at only one branch can currently ring up sales, receive
stock, or record expenses "at" a different branch of the *same* business
by supplying that branch's id. This never crosses the tenant boundary, but
it's real against the finer-grained model the schema supports. **Not
auto-fixed**: wiring this up touches every till/inventory/expense mutation
and changes real staff-facing behaviour (a cashier who could work either
branch yesterday might not be able to tomorrow) — that's a product
decision (build real per-branch enforcement vs. explicitly document branch
id as data-scoping-only, not an authorization boundary), not a bug fix,
per the brief's "explain major changes before making them."

**4. [Medium] `products`/`product_variants` lacked a direct cross-tenant denial test. → FIXED.**
The RLS policy itself was correctly scoped; what was missing was a
standalone test asserting a second business sees zero rows, the way
`tests/security/customers.sql` and `sales.sql` already do — coverage was
only indirect (via inventory-receiving and sale-creation tests). Fixed by
`tests/security/products_cross_tenant.sql`, wired into CI.

**5. [Medium] Several more sensitive actions weren't audit-logged. → FIXED.**
Expense voiding, customer credit-limit changes, branch create/edit, and
general business-settings changes were not wired to `log_audit_event()`.
Fixed: `void_expense()` (migration `0049`) now logs `expense.voided`;
`updateCustomer()` now logs `customer.credit_limit_changed` when the limit
actually changes (`app/(app)/customers/actions.ts`); `createBranch()`/
`updateBranch()` log `branch.created`/`branch.updated`
(`app/(app)/branches/actions.ts`); `updateBusinessProfile()`/
`updateBusinessSettings()` log `business.profile_updated`/
`business.settings_updated` (`app/(app)/settings/business/actions.ts`).
`app/(app)/settings/audit-log/page.tsx`'s `ACTION_LABELS`/`describe()` were
extended to cover all of these plus the pre-existing action types that
previously had no friendly label (Item #9).

**6. [Medium] The "discount cap" feature appears to be schema-only, not enforced. → OPEN — needs a product decision.**
`discounts.apply`/`discounts.apply.unlimited` permissions and a
`default_discount_cap_percent` setting exist, but no code path in the till
or sale-creation logic actually applies or caps a discount at checkout —
the feature is dormant, not built. This directly affected the public
landing page shipped just before this review, which claimed "Discounts
with a cap you control" and "A discount cap so cashiers can't discount
without limit" — exactly the kind of claim the project's own "do not fake
completion" rule exists to catch, and this review is what caught it in its
own recent work, not just the legacy codebase. **Not auto-fixed**: building
real sale-time discount enforcement is a genuine feature addition (UI,
validation, `create_sale()` changes, new tests), not something to bundle
silently into a "fix the security gaps" pass. Needs a decision: build it
for real, or correct the two landing-page/staff-copy claims to stop saying
it exists. Flagged to the user; awaiting direction.

**7. [Low] CSP allows `'unsafe-inline'` on `script-src`/`style-src`. → OPEN.**
Already self-documented in `docs/SECURITY.md` as a known pre-launch item.
Weakens (doesn't eliminate) the CSP's value against injected-script XSS.
Tightening this to a nonce-based policy needs to be verified against an
actual production build/deployment (`next.config.mjs` + how Next 16 and
Tailwind's injected styles interact under a nonce), which is riskier to do
blind than the other items in this pass — left open rather than guessed at.

**8. [Low] `lib/supabase/server.ts` lacked the `import "server-only"` guard `secret-box.ts`/`paystack/client.ts` have. → PARTIALLY FIXED, one file corrected as inapplicable.**
`lib/supabase/server.ts` is 100% server-only code (cookie-bound RLS
client, service-role client) — the guard was added there. The original
finding also named `lib/supabase/env.ts`, but that file also exports
`supabaseUrl()`/`supabaseAnonKey()`, which `lib/supabase/client.ts` — a
`"use client"` file — genuinely imports and needs; adding `server-only`
there would break the client bundle. `supabaseServiceRoleKey()`'s actual
value was never reachable from client code regardless, since only
`NEXT_PUBLIC_`-prefixed env vars are bundled to the browser — this half of
the original finding was a documentation-consistency nit, not an
exploitable gap, and was corrected rather than applied blind.

**9. [Low] Documentation hygiene. → FIXED.**
- `lib/auth/pin.ts` referenced a `lib/auth/rate-limit.ts` file that didn't
  exist yet — now genuinely accurate, since that file exists as of this
  pass; the comment was rewritten to describe what it actually covers.
- The audit-log page's `ACTION_LABELS` map covered 8 of the real action
  types in use — extended to cover all of them (see Item #5).
- `docs/ARCHITECTURE.md`'s phase table marked Phase 19 (Super Admin) and
  Phase 20 (Audit surfaces) as "pending" though both are substantially
  built, and Phase 22 (this review) is now genuinely done — all three
  corrected.

**10. [Informational] Two `/admin` pages rely solely on their layout's guard rather than each independently re-checking `isSuperAdmin()`. → OPEN, not exploitable.**
Not a gap — the `businesses_update` RLS policy independently requires
`app_is_super_admin()` regardless — but worth tidying for consistency with
the layout's own comment describing that as the convention. Left as a
low-priority style item.

**11. [Informational] `lib/env.ts` hardcodes a real personal email and phone number as a fallback support contact. → OPEN, a product/privacy decision.**
Not a credential, but it is real PII shipped in a public repo. Worth the
team's conscious awareness rather than an accident; not changed here since
it's not a security defect to "fix" unilaterally.

## What's genuinely solid (no gaps found)

- **Tenant isolation**: all 34 business-scoped tables have RLS enabled and correctly scoped.
- **Client-trust boundaries**: zero counterexamples across till, sales, products, inventory, customers, expenses, purchase-orders, branches, staff, payments, reports export, and admin.
- **Paystack webhook security**: HMAC verified over the raw body with the correct business's own key, idempotent via a primary-key guard, cross-tenant settlement blocked at the database layer.
- **File uploads**: private storage buckets, MIME/size allow-lists enforced at the storage layer, RLS scoping by business id folder, time-limited signed URLs.
- **SQL injection / input validation**: zod validation server-side on every sampled mutation; zero hand-built SQL strings anywhere.
- **Error handling**: real errors logged server-side, only safe/generic or hand-written messages ever reach a user.
- **Hardcoded IDs**: none found in application code.
- **Super admin boundary**: no user-reachable path to setting `is_super_admin`; a protective trigger blocks self-modification.
- **Staff privilege escalation**: promoting to Owner requires an extra check, nobody can act on their own account through these paths, and the last Owner cannot be demoted or deactivated.

## Open items and who should decide them

| # | Item | Why it's open |
|---|---|---|
| 3 | Branch-level permission enforcement | Product decision: real per-branch enforcement vs. document branch id as data-scoping-only |
| 6 | Discount-cap enforcement | Product decision: build it for real vs. correct the landing-page/staff-copy claims |
| 7 | CSP `'unsafe-inline'` | Needs verification against a real production build before changing |
| 10 | `/admin` pages' independent re-check | Low-priority style consistency, not a real gap |
| 11 | Hardcoded support contact in `lib/env.ts` | Privacy/product decision, not a code defect |

None of the "Pass"/"Fixed" verdicts above should be read as "perfect
forever" — they're accurate as of this pass. Re-running a review like this
after major changes (especially to payments, staff/roles, or anything
touching RLS) is worth doing again rather than assuming it still holds.