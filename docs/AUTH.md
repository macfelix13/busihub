# Busihub — Authentication

## What's implemented (foundation phase)

| Flow | Where |
|---|---|
| Business registration (signUp + `register_business()`) | `app/(auth)/register/actions.ts` |
| Login (+ finishes pending registration if email confirmation delayed it) | `app/(auth)/login/actions.ts` |
| Staff invite (Auth Admin `inviteUserByEmail()` + `invite_staff_member()`) | `app/(app)/settings/staff/actions.ts`, `supabase/migrations/0036_staff_management.sql` |
| Staff invite acceptance (sets the invited person's password) | `app/(auth)/accept-invite/page.tsx` |
| Logout | `lib/auth/sign-out.ts` |
| Password reset request | `app/(auth)/reset-password/actions.ts` |
| Password update (from reset email link) | `app/(auth)/update-password/page.tsx` |
| Session refresh on every request | `proxy.ts` → `lib/supabase/middleware.ts` |
| Cashier PIN storage, self-set or admin-set with `users.manage` | `set_profile_pin()`, `supabase/migrations/0018_pin_security_and_till_login.sql` |
| Till PIN unlock — checks only the signed-in account's own PIN | `app/(app)/till/actions.ts` (`verifyOwnPin`), `verify_profile_pin(p_pin)` (`supabase/migrations/0039_till_pin_self_only.sql`) |
| Shared-till "switch user" — a real password sign-in, not a PIN check on someone else | `app/(app)/till/actions.ts` (`switchTillUser`) |

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
4. The invited person clicks the email link, lands on `/accept-invite`, sets a password, and signs in as themself
   from then on — an ordinary login, no different from the Owner's.

**Why the invite link needs its own confirm page, not `app/auth/confirm/route.ts`**: that route only handles the
PKCE `?code=` query param used by `signUp()` and `resetPasswordForEmail()`, which works because those flows are
*initiated by the invitee's own browser* using a client that generated a matching `code_verifier` for the exchange.
`inviteUserByEmail()` is called from the server by whoever is doing the inviting — there's no browser-side
`code_verifier` anywhere for a `?code=` to pair with, so Supabase falls back to the older implicit-flow style for
this one case: the session lands directly in the redirect URL's `#fragment` (`#access_token=...&refresh_token=...`)
instead of a query param. Fragments never reach the server (the browser strips them before the request is even
sent), so `/accept-invite` (`app/(auth)/accept-invite/page.tsx`) is a client component that reads
`window.location.hash` itself, calls `supabase.auth.setSession()` with the tokens it finds, and only then shows the
"choose a password" form. An expired or already-used invite link redirects here with `#error=access_denied&...`
instead of tokens, which the page shows as a plain "ask for a new invite" message rather than a raw error.

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

## Till PIN & shared-till switching (Section 6)

The till (`/till`) is not a separate login — the browser is already signed in as a real Supabase Auth account, and the PIN just confirms it's genuinely that person standing at the counter before letting them sell. This has changed shape once:

- **Before `0039_till_pin_self_only.sql`**: `verify_profile_pin(p_profile_id, p_pin)` took a target profile and only checked that it belonged to the caller's own business — not that it *was* the caller. The till's "Who's at the till? Pick your name" screen let anyone type a colleague's PIN and have the sale attributed to that colleague, on the theory that the device itself stayed signed in as whoever all day. `docs/RBAC.md` documented the resulting risk (a sale's `cashier_id` could diverge from `created_by`) as a known, deliberate limitation.
- **From 0039 on**: `verify_profile_pin(p_pin)` takes only the PIN and always checks it against `auth.uid()` — there is no parameter left to name anyone else, so this can never again be used to "become" a colleague. `create_sale()`/`create_refund()` got the matching fix: `cashier_id` is always set to `auth.uid()` server-side, and a client-supplied `p_cashier_id` that doesn't match the caller is a hard `42501` rejection rather than something silently honoured.

The current flow, all in `app/(app)/till/actions.ts` and `app/(app)/till/pin-pad.tsx`:

1. `verifyOwnPin()` calls `verify_profile_pin(p_pin)` for whoever `auth.getUser()` says is signed in. A correct PIN calls `startTillSession()` (`lib/auth/till-session.ts`) — a signed HMAC-SHA256 cookie, 12-hour lifetime (a shift, not a login) — and the till's selling screen renders. This cookie is never treated as authorization on its own: every write still goes through the caller's real Supabase session and RLS; it only gates which UI renders.
2. `readTillSession(currentUserId)` refuses to honour a cookie whose `cashierId` doesn't match the currently signed-in account, so an unlock from one login can never carry over to a different one — belt-and-suspenders alongside `switchTillUser()` explicitly clearing it.
3. Handing the till to a colleague is **"Switch user"**, not a PIN entry: `switchTillUser()` calls `supabase.auth.signInWithPassword({ email, password })` — the exact mechanism `app/(auth)/login/actions.ts` uses — so the colleague is genuinely signed in as themselves, ends the previous till session, and lands back at `/till` to unlock with their own PIN.
4. Lockout (`pin_failed_attempts`/`pin_locked_until`, 5 wrong attempts → 15 minutes) is enforced inside `verify_profile_pin()` itself, same as before 0039, just scoped to the caller.

`set_profile_pin()` (self-set, or admin-set on a colleague with `users.manage`) is unaffected by any of this — it provisions a PIN, it doesn't use one to authenticate as someone else.

## MFA, phone auth, Google OAuth

Supabase Auth supports all three natively; none are wired into the Busihub UI yet. Planned for the phase that builds out full account/security settings (Section 6 calls for MFA to be required for Owner/Super Admin roles by policy) — noted here rather than silently deferred.

## Rate limiting / brute-force protection

Supabase Auth applies its own baseline rate limits to `signInWithPassword`/`signUp`/`resetPasswordForEmail` out of the box. An additional application-level layer (e.g. Upstash Ratelimit, keyed per-IP and per-account) is recommended before production launch and is tracked as a known gap in `docs/SECURITY.md` rather than faked here — see that document for why it wasn't built speculatively in this phase.

## Session handling

`@supabase/ssr` cookie-based sessions only — never `localStorage`. `proxy.ts` refreshes the session on every request (`lib/supabase/middleware.ts`); `lib/supabase/server.ts` provides the RLS-scoped server client used by Server Components/Actions, and a separate `createServiceRoleClient()` for the small set of operations that must bypass RLS (documented inline in that file — the Paystack webhook, Super Admin reads, and the one Auth Admin API call `inviteStaff()` makes to create a new colleague's `auth.users` row).