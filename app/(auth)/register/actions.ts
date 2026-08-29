"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { registerSchema } from "@/lib/validation/auth";

export interface RegisterFormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Registration flow (Section 5, Section 6): Supabase Auth creates the
 * credential (auth.users row), then register_business() — a single
 * Postgres transaction (supabase/migrations/0011) — creates the business,
 * main branch, owner profile, seeded roles, Owner role assignment, and
 * trial subscription atomically. If register_business() fails after
 * signUp() succeeded, we're left with an auth user but no profile; the
 * user can retry (register_business raises a clear "already linked to a
 * business" error only once a profile actually exists), and this
 * partially-created state is safe because every other table's RLS
 * requires a profile row to resolve app_current_business_id() — an
 * orphaned auth user with no profile can authenticate but can't read or
 * write any tenant data.
 */
export async function registerBusiness(
  _prevState: RegisterFormState,
  formData: FormData
): Promise<RegisterFormState> {
  const parsed = registerSchema.safeParse({
    businessName: formData.get("businessName"),
    ownerFirstName: formData.get("ownerFirstName"),
    ownerLastName: formData.get("ownerLastName"),
    email: formData.get("email"),
    phone: formData.get("phone"),
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
    return { error: "Please fix the errors below.", fieldErrors };
  }

  const { businessName, ownerFirstName, ownerLastName, email, phone, password } = parsed.data;

  const supabase = await createServerSupabaseClient();

  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // Carried on auth.users.raw_user_meta_data so that login/actions.ts
      // can finish register_business() on first sign-in if email
      // confirmation is required and there was no session here to call
      // it with (see the comment below).
      data: {
        first_name: ownerFirstName,
        last_name: ownerLastName,
        pending_business_name: businessName,
        pending_business_phone: phone || null,
      },
    },
  });

  if (signUpError) {
    // Supabase's own message is safe to show for the common cases
    // (e.g. "User already registered") but never forward raw internal
    // errors to the client (Section 38).
    const message = signUpError.status === 400 || signUpError.status === 422
      ? signUpError.message
      : "We couldn't create your account right now. Please try again.";
    return { error: message };
  }

  if (!signUpData.user) {
    return { error: "We couldn't create your account right now. Please try again." };
  }

  // If email confirmation is required, there is no session yet and
  // register_business() (which reads auth.uid() from the session) can't
  // run until the user confirms and signs in. In that case, defer
  // business creation to first login — see app/(auth)/login/actions.ts,
  // which calls register_business() itself if the signed-in user has no
  // profile yet, carrying the pending business name via user metadata.
  if (!signUpData.session) {
    redirect("/verify-email");
  }

  const { error: rpcError } = await supabase.rpc("register_business", {
    p_business_name: businessName,
    p_owner_first_name: ownerFirstName,
    p_owner_last_name: ownerLastName || "",
    p_phone: phone || null,
  });

  if (rpcError) {
    return {
      error:
        "Your account was created but we couldn't finish setting up your business. Please try signing in — we'll finish setup automatically.",
    };
  }

  redirect("/dashboard");
}
