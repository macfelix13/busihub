"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { supabaseAppUrl } from "@/lib/env";

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

  // Always return the same "submitted" response whether or not the email
  // exists — this endpoint must not be usable to enumerate accounts
  // (Section 6, Section 29).
  // Routed through /auth/confirm to exchange the PKCE `code` this link
  // carries for a session server-side before landing on /update-password —
  // see app/auth/confirm/route.ts for why that step can't be skipped.
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${supabaseAppUrl()}/auth/confirm?next=/update-password`,
  });

  return { submitted: true };
}