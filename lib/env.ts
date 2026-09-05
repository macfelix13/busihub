/** Non-Supabase app-level environment variables. */
export function supabaseAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/**
 * Busihub's own support contact — not any tenant's, Busihub's. Shown on
 * the suspended/closed-account screen (app/(app)/layout.tsx) and
 * anywhere else platform-level contact info is needed. Read from an env
 * var rather than hardcoded only in JSX so it can be changed later with a
 * Vercel env var update and redeploy, not a code change — the fallback
 * values are today's real numbers, not placeholders, so this works
 * correctly even before anyone sets the env var.
 */
export function supportEmail(): string {
  return process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@busihub.app";
}

export function supportPhone(): string {
  return process.env.NEXT_PUBLIC_SUPPORT_PHONE ?? "+233543945668";
}