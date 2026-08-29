"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loginSchema } from "@/lib/validation/auth";

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
    return { error: "Please fix the errors below.", fieldErrors };
  }

  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    // Deliberately generic — do not reveal whether the email exists
    // (Section 6: failed-login protection / user enumeration).
    return { error: "Incorrect email or password." };
  }

  // First sign-in after an email-confirmation-gated signUp(): no profile
  // exists yet, but the pending business details were carried on
  // raw_user_meta_data at signUp time. Finish setup now that we have a
  // real session for register_business() to run under.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", data.user.id)
    .maybeSingle();

  if (!profile) {
    const meta = data.user.user_metadata as Record<string, unknown>;
    const pendingBusinessName = typeof meta.pending_business_name === "string" ? meta.pending_business_name : null;

    if (pendingBusinessName) {
      const { error: rpcError } = await supabase.rpc("register_business", {
        p_business_name: pendingBusinessName,
        p_owner_first_name: typeof meta.first_name === "string" ? meta.first_name : "",
        p_owner_last_name: typeof meta.last_name === "string" ? meta.last_name : "",
        p_phone: typeof meta.pending_business_phone === "string" ? meta.pending_business_phone : null,
      });

      if (rpcError) {
        return {
          error: "You're signed in, but we couldn't finish setting up your business. Please contact support.",
        };
      }
    } else {
      // No pending business metadata either — an account with no
      // business/profile link at all (e.g. a Super Admin, or a staff
      // invite flow from a future phase). Not an error here.
    }
  }

  redirect("/dashboard");
}
