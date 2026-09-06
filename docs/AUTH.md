# Busihub — Authentication

## What's implemented (foundation phase)

| Flow | Where |
|---|---|
| Business registration (signUp + `register_business()`) | `app/(auth)/register/actions.ts` |
| Login (+ finishes pending registration if email confirmation delayed it) | `app/(auth)/login/actions.ts` |
| Staff invite (Auth Admin `inviteUserByEmail()` + `invite_staff_member()`) | `app/(app)/settings/staff/actions.ts`, `supabase/migrations/0036_staff_management.sql` |
| Logout | `lib/auth/sign-out.ts` |
| Password reset request | `app/(auth)/reset-password/actions.ts` |
| Password update (from reset email link) | `app/(auth)/update-password/page.tsx` |
| Session refresh on every request | `proxy.ts` → `lib/supabase/middleware.ts` |
| Cashier PIN hashing/verification (library, not yet wired to a POS UI) | `lib/auth/pin.ts` |
| Cashier PIN storage (server-side, permission-checked) | `set_cashier_pin()`, `supabase/migrations/0011_business_registration.sql` |

## Registration flow, in detail

1. User submits the registration form. `registerSchema` (`lib/validation/auth.ts`) validates it — same schema shape the client used for inline feedback, re-run server-side because the client is never trusted.
2. `supabase.auth.signUp()` creates the `auth.users` row. Business details (name, phone) and the owner's name are attached as `user_metadata` at signUp time — this is what lets step 4 recover if email confirmation delays the session.
3. **If Supabase Auth returns a session immediately** (email confirmation disabled, or auto-confirmed in dev), the Server Action calls `register_business()` right away and redirects to `/dashboard`.
4. **If email confirmation is required**, there's no session yet, so `register_business()` can't run (it reads `auth.uid()`). The user is sent to `/verify-email`. On their first successful login afterward, `app/(auth)/login/actions.ts` checks whether a `profiles` row exists yet; if not, it reads the pending business details back out of `user_metadata` and calls `register_business()` then.
5. Either way, `register_business()` (Postgres function, `SECURITY DEFINER`) does the business+branch+profile+roles+subscription creation as one atomic transaction — see `docs/DATABASE.md`.

An account that completed step 2 but never reaches step 3/4 successfully (e.g. the user closes the tab before confirming email, or `register_business()` fails) is inert: `profiles` has no row for them, and every RLS policy in the schema requires `app_current_business_id()` (which reads `profiles.business_id`) to resolve to something — so they can sign in but cannot read or write any tenant data. Retrying registration/login is the recovery path; there is no separate cleanup job needed.

## Staff invite flow, in detail

Unlike registration, this one doesn't need a "finish after email confirmation" step — the auth account and the
profile/role are created in the same request, by the inviting Owner/Manager, not deferred to whenever the invited
person clicks the link.

1. An Owner/Manager with `users.manage` submits the invite form (`app/(app)/settings/staff/actions.ts`,
   `inviteStaff()`). `requirePermission()` checks `users.manage`, and the chosen branch/role are re-verified to
   belong to the caller's own business before anything else happens.
2. `createServiceRoleClient().auth.admin.inviteUserByEmail()` creates the `auth.users` row and sends Supabase's own
   "set your password" email — no separate email service to configure. This is the one legitimate use of the
   service-role client here: Postgres has no access to Auth's admin API, so this step can't be a SQL function.
3. `invite_staff_member()` (`supabase/migrations/0036_staff_management.sql`, `SECURITY DEFINER`) runs immediately
   afterward, through the caller's own RLS-scoped session — it re-derives the caller's `business_id` from their own
   profile (never accepts one as an argument) and re-checks `users.manage` itself, then creates the new profile and
   `user_branch_roles` row atomically, and audit-logs `user.invited`.
4. The invited person clicks the email link, sets a password, and signs in as themself from then on — an ordinary
   login, no different from the Owner's.

**Escalation guard**: `seed_default_roles_for_business()` (0011) gives Manager `users.manage` but not
`business.manage`. Without a check, a Manager could invite a colleague and directly hand them the Owner role —
instantly outranking the Manager who created them. Granting (or later moving someone into) the Owner role therefore
additionally requires `business.manage`, checked inside `invite_staff_member()`/`update_staff_role()` themselves, not
just in the UI.

**Lockout guard**: `update_staff_role()` and `set_staff_status()` both refuse a change that would leave the business
with zero active Owner-role holders, and both refuse to let a user act on their own row — self-service role/status
changes aren't offered anywhere, so one admin's mistake can't strand a whole business with no one able to undo it.

**An account that never reaches step 3** (the `inviteUserByEmail()` call succeeds but the RPC call fails — a network
blip, or the branch/role got deleted in between) is inert in exactly the same way an incomplete self-registration is
(see above): no `profiles` row means no RLS policy resolves `app_current_business_id()` for them, so they can sign in
but read or write nothing. The owner sees a clear error either way and can just invite the same email again.

**Deactivation** (`set_staff_status()`) sets `profiles.status = 'inactive'`, enforced at `app/(app)/layout.tsx` —
the same place `businesses.status` is enforced — so a deactivated colleague is signed out of every route under
`(app)`, not just hidden from a list somewhere.

**Known limitation, not faked as solved**: `inviteUserByEmail()` sends through Supabase's own built-in email
sending, which is fine for development and low volume but is rate-limited and not meant for production traffic at
scale (the same built-in sender the registration-confirmation email already relies on). Before relying on invites
at real volume, configure a custom SMTP provider in the Supabase dashboard (Authentication → Email) — no code change
needed here either way, since this app never talks to an email provider directly.

## Cashier PIN (Section 6)

The Postgres side (`set_cashier_pin()`, `pin_hash`/`pin_failed_attempts`/`pin_locked_until` columns) and the hashing library (`lib/auth/pin.ts`, bcrypt) are in place. **Not yet built**: the Route Handler that verifies a submitted PIN against the hash, applies the lockout policy (`PIN_LOCKOUT_THRESHOLD` / `PIN_LOCKOUT_DURATION_MINUTES`), and mints a cashier-scoped session — that lands with the POS phase (Section 6, `docs/ARCHITECTURE.md` §5), since it only makes sense once there's a POS screen for it to unlock into.

## MFA, phone auth, Google OAuth

Supabase Auth supports all three natively; none are wired into the Busihub UI yet. Planned for the phase that builds out full account/security settings (Section 6 calls for MFA to be required for Owner/Super Admin roles by policy) — noted here rather than silently deferred.

## Rate limiting / brute-force protection

Supabase Auth applies its own baseline rate limits to `signInWithPassword`/`signUp`/`resetPasswordForEmail` out of the box. An additional application-level layer (e.g. Upstash Ratelimit, keyed per-IP and per-account) is recommended before production launch and is tracked as a known gap in `docs/SECURITY.md` rather than faked here — see that document for why it wasn't built speculatively in this phase.

## Session handling

`@supabase/ssr` cookie-based sessions only — never `localStorage`. `proxy.ts` refreshes the session on every request (`lib/supabase/middleware.ts`); `lib/supabase/server.ts` provides the RLS-scoped server client used by Server Components/Actions, and a separate `createServiceRoleClient()` for the small set of operations that must bypass RLS (documented inline in that file — the Paystack webhook, Super Admin reads, and the one Auth Admin API call `inviteStaff()` makes to create a new colleague's `auth.users` row).