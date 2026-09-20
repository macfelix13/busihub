/** Non-Supabase app-level environment variables. */
export function supabaseAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/**
 * Busihub's own support contact — not any tenant's, Busihub's. Shown on
 * the suspended/closed-account screen (app/(app)/layout.tsx) and
 * anywhere else platform-level contact info is needed. Read from an env
 * var rather than hardcoded only in JSX so it can be changed later with a
 * Vercel env var update and redeploy, not a code change.
 *
 * The email fallback is a real, working Gmail address (macfelix13@gmail.com)
 * for now, not the placeholder-looking "support@busihub.app" this used to
 * be — that domain was never actually registered, so that address could
 * never have received mail. Swap it here (or via the env var) once a real
 * busihub.app mailbox exists.
 */
export function supportEmail(): string {
  return process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "macfelix13@gmail.com";
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
 */
export function paystackPlatformSecretKey(): string | undefined {
  return process.env.PAYSTACK_PLATFORM_SECRET_KEY;
}

export function paystackPlatformPublicKey(): string | undefined {
  return process.env.PAYSTACK_PLATFORM_PUBLIC_KEY;
}