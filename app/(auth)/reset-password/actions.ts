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
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${supabaseAppUrl()}/update-password`,
  });

  return { submitted: true };
}
