# Busihub — Authentication

## What's implemented (foundation phase)

| Flow | Where |
|---|---|
| Business registration (signUp + `register_business()`) | `app/(auth)/register/actions.ts` |
| Login (+ finishes pending registration if email confirmation delayed it) | `app/(auth)/login/actions.ts` |
| Logout | `lib/auth/sign-out.ts` |
| Password reset request | `app/(auth)/reset-password/actions.ts` |
| Password update (from reset email link) | `app/(auth)/update-password/page.tsx` |
| Session refresh on every request | `middleware.ts` → `lib/supabase/middleware.ts` |
| Cashier PIN hashing/verification (library, not yet wired to a POS UI) | `lib/auth/pin.ts` |
| Cashier PIN storage (server-side, permission-checked) | `set_cashier_pin()`, `supabase/migrations/0011_business_registration.sql` |

## Registration flow, in detail

1. User submits the registration form. `registerSchema` (`lib/validation/auth.ts`) validates it — same schema shape the client used for inline feedback, re-run server-side because the client is never trusted.
2. `supabase.auth.signUp()` creates the `auth.users` row. Business details (name, phone) and the owner's name are attached as `user_metadata` at signUp time — this is what lets step 4 recover if email confirmation delays the session.
3. **If Supabase Auth returns a session immediately** (email confirmation disabled, or auto-confirmed in dev), the Server Action calls `register_business()` right away and redirects to `/dashboard`.
4. **If email confirmation is required**, there's no session yet, so `register_business()` can't run (it reads `auth.uid()`). The user is sent to `/verify-email`. On their first successful login afterward, `app/(auth)/login/actions.ts` checks whether a `profiles` row exists yet; if not, it reads the pending business details back out of `user_metadata` and calls `register_business()` then.
5. Either way, `register_business()` (Postgres function, `SECURITY DEFINER`) does the business+branch+profile+roles+subscription creation as one atomic transaction — see `docs/DATABASE.md`.

An account that completed step 2 but never reaches step 3/4 successfully (e.g. the user closes the tab before confirming email, or `register_business()` fails) is inert: `profiles` has no row for them, and every RLS policy in the schema requires `app_current_business_id()` (which reads `profiles.business_id`) to resolve to something — so they can sign in but cannot read or write any tenant data. Retrying registration/login is the recovery path; there is no separate cleanup job needed.

## Cashier PIN (Section 6)

The Postgres side (`set_cashier_pin()`, `pin_hash`/`pin_failed_attempts`/`pin_locked_until` columns) and the hashing library (`lib/auth/pin.ts`, bcrypt) are in place. **Not yet built**: the Route Handler that verifies a submitted PIN against the hash, applies the lockout policy (`PIN_LOCKOUT_THRESHOLD` / `PIN_LOCKOUT_DURATION_MINUTES`), and mints a cashier-scoped session — that lands with the POS phase (Section 6, `docs/ARCHITECTURE.md` §5), since it only makes sense once there's a POS screen for it to unlock into.

## MFA, phone auth, Google OAuth

Supabase Auth supports all three natively; none are wired into the Busihub UI yet. Planned for the phase that builds out full account/security settings (Section 6 calls for MFA to be required for Owner/Super Admin roles by policy) — noted here rather than silently deferred.

## Rate limiting / brute-force protection

Supabase Auth applies its own baseline rate limits to `signInWithPassword`/`signUp`/`resetPasswordForEmail` out of the box. An additional application-level layer (e.g. Upstash Ratelimit, keyed per-IP and per-account) is recommended before production launch and is tracked as a known gap in `docs/SECURITY.md` rather than faked here — see that document for why it wasn't built speculatively in this phase.

## Session handling

`@supabase/ssr` cookie-based sessions only — never `localStorage`. `middleware.ts` refreshes the session on every request (`lib/supabase/middleware.ts`); `lib/supabase/server.ts` provides the RLS-scoped server client used by Server Components/Actions, and a separate `createServiceRoleClient()` for the small set of operations that must bypass RLS (documented inline in that file — restricted to webhooks and Super Admin reads, none of which exist yet in this phase).
