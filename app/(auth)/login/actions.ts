"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loginSchema } from "@/lib/validation/auth";
import { finishPendingRegistrationIfNeeded } from "@/lib/auth/finish-pending-registration";
import {
  checkRateLimit,
  recordRateLimitAttempt,
  lockoutMessage,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_LOCKOUT_MINUTES,
} from "@/lib/auth/rate-limit";

export interface LoginFormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

export async function login(
  _prevState: LoginFormState,
  formData: FormData
): Promise<LoginFormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    }
    console.error("login: schema validation failed", {
      rawEmail: formData.get("email"),
      hasPassword: Boolean(formData.get("password")),
      fieldErrors,
    });
    return { error: "Please fix the errors below.", fieldErrors };
  }

  const supabase = await createServerSupabaseClient();

  // Section 6 / security-audit Gap #1: unlimited password-guessing
  // against a known email was otherwise possible from this code path
  // alone. Locked the same shape PIN entry already has (0039) — 8
  // attempts, 15-minute lockout — just keyed by email since there is no
  // profile row to attach a counter to before a login has succeeded.
  // loginSchema already trims + lowercases the email (lib/validation/auth.ts).
  const rateKey = `login:${parsed.data.email}`;
  const rateStatus = await checkRateLimit(supabase, rateKey);
  if (!rateStatus.allowed && rateStatus.retryAfter) {
    return { error: lockoutMessage(rateStatus.retryAfter) };
  }

  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  await recordRateLimitAttempt(supabase, rateKey, !error, LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_MINUTES);

  if (error) {
    // The message shown to the user is deliberately generic — do not
    // reveal whether the email exists (Section 6: failed-login
    // protection / user enumeration) — but log the real reason
    // server-side so this is diagnosable during testing.
    console.error("login: signInWithPassword failed", {
      status: error.status,
      name: error.name,
      message: error.message,
    });
    return { error: "Incorrect email or password." };
  }

  // First sign-in after an email-confirmation-gated signUp() that wasn't
  // already finished via app/auth/confirm/route.ts (e.g. the user typed
  // their password in here instead of using the email link, or the link's
  // code exchange failed and sent them here as a fallback): no profile
  // exists yet, but the pending business details were carried on
  // raw_user_meta_data at signUp time. Finish setup now that we have a
  // real session for register_business() to run under. See that shared
  // helper's doc comment for why this is safe to call unconditionally.
  try {
    await finishPendingRegistrationIfNeeded(supabase);
  } catch (err) {
    console.error("login: finishPendingRegistrationIfNeeded failed", err);
    return {
      error: "You're signed in, but we couldn't finish setting up your business. Please contact support.",
    };
  }

  redirect("/dashboard");
}