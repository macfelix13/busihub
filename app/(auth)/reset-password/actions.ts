"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { supabaseAppUrl } from "@/lib/env";
import { checkRateLimit, recordRateLimitAttempt, RESET_MAX_REQUESTS, RESET_LOCKOUT_MINUTES } from "@/lib/auth/rate-limit";

export interface ResetPasswordState {
  submitted?: boolean;
  error?: string;
}

export async function requestPasswordReset(
  _prevState: ResetPasswordState,
  formData: FormData
): Promise<ResetPasswordState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return { error: "Enter a valid email address." };
  }

  const supabase = await createServerSupabaseClient();

  // Security-audit Gap #1: this endpoint had no limit at all on how many
  // reset emails could be triggered for one address. Rate-limited by
  // request count, not success/failure (see migration 0048's header for
  // why) — after RESET_MAX_REQUESTS within the lockout window, further
  // requests are silently no-ops rather than sending another email.
  const rateKey = `reset:${email}`;
  const rateStatus = await checkRateLimit(supabase, rateKey);
  if (rateStatus.allowed) {
    // Always return the same "submitted" response whether or not the
    // email exists, and now also whether or not it was just rate-limited
    // — this endpoint must not be usable to enumerate accounts or
    // distinguish those two cases from the outside (Section 6, Section 29).
    // Routed through /auth/confirm to exchange the PKCE `code` this link
    // carries for a session server-side before landing on /update-password —
    // see app/auth/confirm/route.ts for why that step can't be skipped.
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${supabaseAppUrl()}/auth/confirm?next=/update-password`,
    });
    await recordRateLimitAttempt(supabase, rateKey, false, RESET_MAX_REQUESTS, RESET_LOCKOUT_MINUTES);
  }

  return { submitted: true };
}