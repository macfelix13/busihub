/** Non-Supabase app-level environment variables. */
export function supabaseAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/**
 * Busihub's own official administrative/support contact — not any
 * tenant's, Busihub's, and the same one address for every business on
 * the platform, the console's own support inbox, and anything
 * marketing-facing. Shown on the suspended/closed-account screen
 * (app/(app)/layout.tsx), Settings -> Billing, and the dashboard's "Need
 * help?" card (app/(app)/dashboard/support-card.tsx) — read from here
 * rather than hardcoded per page so a future change is one edit, not a
 * hunt through every place it's mentioned (a real one of those existed
 * until this pass: the dashboard card had its own separate hardcoded
 * address that had drifted out of sync with this one — see the
 * changelog entry for when and why that got consolidated here too).
 *
 * Read from an env var rather than hardcoded only in JSX so it can be
 * changed later with a Vercel env var update and redeploy, not a code
 * change — set NEXT_PUBLIC_SUPPORT_EMAIL to override the fallback below
 * without touching code at all.
 *
 * The fallback is a real, working Gmail address (busihub35@gmail.com,
 * set 2026-09-20 as the official one going forward — replacing an
 * earlier personal placeholder), not the placeholder-looking
 * "support@busihub.app" this used to be — that domain was never actually
 * registered, so that address could never have received mail. Swap it
 * here (or via the env var) once a real busihub.app mailbox exists.
 */
export function supportEmail(): string {
  return process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "busihub35@gmail.com";
}

export function supportPhone(): string {
  return process.env.NEXT_PUBLIC_SUPPORT_PHONE ?? "+233543945668";
}

/**
 * Shared secret Vercel Cron is expected to send back as
 * `Authorization: Bearer <value>` (see app/api/cron/subscriptions/route.ts
 * and vercel.json). No fallback, unlike the two functions above — an
 * unset CRON_SECRET must fail closed (the route refuses every request,
 * including Vercel's own) rather than silently accepting an unauthenticated
 * caller.
 */
export function cronSecret(): string | undefined {
  return process.env.CRON_SECRET;
}

/**
 * Busihub's OWN Paystack account — distinct from, and unrelated to, every
 * shop's own Paystack credentials in business_payment_settings
 * (lib/paystack/client.ts). Those let a SHOP collect from its own
 * customers; this is Busihub collecting subscription payments from a
 * shop. Read directly from the environment, never encrypted-at-rest like
 * a shop's key (lib/crypto/secret-box.ts) — there is exactly one of
 * these, it is a deployment-level secret set once in Vercel, not
 * end-user-supplied data stored per business. See
 * lib/paystack/platform-client.ts for what calls this.
 *
 * The env var itself is named PAYSTACK_SECRET_KEY/PAYSTACK_PUBLIC_KEY (no
 * "PLATFORM" in the Vercel variable name, by request, since there's no
 * naming collision to avoid — the per-shop credentials above are never
 * env vars at all, only rows in the database). The function names below
 * keep saying "Platform" on purpose, so it stays obvious at every call
 * site which of the two Paystack integrations a value came from, even
 * though the deployed variable name is shorter.
 */
export function paystackPlatformSecretKey(): string | undefined {
  return process.env.PAYSTACK_SECRET_KEY;
}

export function paystackPlatformPublicKey(): string | undefined {
  return process.env.PAYSTACK_PUBLIC_KEY;
}