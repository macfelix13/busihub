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