import "server-only";
import type { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * App-level rate limiting / lockout for password-based sign-in and
 * password-reset requests (security-audit Gap #1, 2026-09 review). Wraps
 * the two SECURITY DEFINER functions from migration 0048
 * (auth_rate_limit_check / auth_rate_limit_record) — see that migration
 * for the schema and why this is keyed by an arbitrary string rather than
 * a profile id.
 *
 * Mirrors the shape cashier PIN entry already had (5 attempts / 15
 * minutes, migration 0039) — this just extends the same kind of
 * protection to the three code paths that call Supabase Auth directly
 * with no lockout at all: login(), switchTillUser(), and
 * requestPasswordReset().
 */

type SupabaseServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

/** Failed real-login attempts (password sign-in): login() and switchTillUser(). */
export const LOGIN_MAX_ATTEMPTS = 8;
export const LOGIN_LOCKOUT_MINUTES = 15;

/** Password-reset REQUESTS (not failures — see 0048's header for why). */
export const RESET_MAX_REQUESTS = 3;
export const RESET_LOCKOUT_MINUTES = 15;

export interface RateLimitStatus {
  allowed: boolean;
  retryAfter: Date | null;
}

/**
 * Checks whether `key` is currently locked out, without recording an
 * attempt. Call this BEFORE the real operation (signInWithPassword,
 * resetPasswordForEmail) so a locked-out caller never even reaches it.
 */
export async function checkRateLimit(supabase: SupabaseServerClient, key: string): Promise<RateLimitStatus> {
  const { data, error } = await supabase.rpc("auth_rate_limit_check", { p_key: key });

  if (error) {
    console.error("checkRateLimit: rpc failed", { key, error });
    // Fail OPEN on an infra error — a broken rate-limit table must never
    // itself become a way to lock every user out of the app. The real
    // login/PIN checks underneath are the actual security boundary; this
    // is defense in depth on top of them.
    return { allowed: true, retryAfter: null };
  }

  return { allowed: !data, retryAfter: data ? new Date(data as string) : null };
}

/**
 * Records what just happened for `key` and applies/clears the lockout.
 * Call this AFTER the real operation, passing whether it actually
 * succeeded (see 0048's header for the password-reset special case,
 * where `success` is always passed as false).
 */
export async function recordRateLimitAttempt(
  supabase: SupabaseServerClient,
  key: string,
  success: boolean,
  maxAttempts: number,
  lockoutMinutes: number
): Promise<void> {
  const { error } = await supabase.rpc("auth_rate_limit_record", {
    p_key: key,
    p_success: success,
    p_max_attempts: maxAttempts,
    p_lockout_minutes: lockoutMinutes,
  });

  if (error) {
    console.error("recordRateLimitAttempt: rpc failed", { key, error });
  }
}

/** A user-facing message for a locked-out attempt. Never reveals the attempt count. */
export function lockoutMessage(retryAfter: Date): string {
  const minutes = Math.max(1, Math.ceil((retryAfter.getTime() - Date.now()) / 60000));
  return `Too many attempts. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}