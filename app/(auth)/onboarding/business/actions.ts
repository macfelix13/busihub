"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { completeBusinessSchema } from "@/lib/validation/auth";

export interface CompleteBusinessFormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * The "what's your business called?" step for a brand-new Google/Apple
 * sign-in — see app/auth/confirm/route.ts and
 * lib/auth/finish-pending-registration.ts's own comments for why this
 * exists: the provider never sends a business name the way the
 * email/password form (app/(auth)/register/actions.ts) collects one
 * upfront, so it's collected here instead, once, right after the OAuth
 * redirect back to this app and before landing anywhere else.
 *
 * `next` is whatever app/auth/confirm/route.ts was originally asked to
 * redirect to before it detected this case (almost always /dashboard) —
 * carried through the page as a hidden field so this action doesn't have
 * to guess.
 */
export async function completeBusinessOnboarding(
  _prevState: CompleteBusinessFormState,
  formData: FormData
): Promise<CompleteBusinessFormState> {
  const parsed = completeBusinessSchema.safeParse({
    businessName: formData.get("businessName"),
    ownerFirstName: formData.get("ownerFirstName"),
    ownerLastName: formData.get("ownerLastName"),
    phone: formData.get("phone"),
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

  const { businessName, ownerFirstName, ownerLastName, phone } = parsed.data;
  const next = String(formData.get("next") ?? "/dashboard");

  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // The session cookie is what got them to this page at all — this
    // shouldn't happen, but if it does, sending them to sign in again is
    // the only sane recovery.
    redirect("/login");
  }

  // register_business() itself already raises 23505 ("This account is
  // already linked to a business") if a profile exists — re-checking
  // here is redundant with that, not a substitute for it, but it means a
  // double-submit (e.g. a second tab) gets a friendlier message than a
  // raw database error would.
  const { data: existingProfile } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (existingProfile) {
    redirect(next);
  }

  const { error } = await supabase.rpc("register_business", {
    p_business_name: businessName,
    p_owner_first_name: ownerFirstName,
    p_owner_last_name: ownerLastName || "",
    p_phone: phone || null,
  });

  if (error) {
    console.error("completeBusinessOnboarding: register_business rpc failed", error);
    // 23505 (already linked) and 22023 (blank business name, though
    // completeBusinessSchema already rejects that client- and
    // server-side) are register_business()'s own friendly, user-facing
    // messages — safe to forward verbatim, same convention every other
    // caller of this RPC already uses.
    const message =
      error.code === "23505" || error.code === "22023"
        ? error.message
        : "We couldn't finish setting up your business. Please try again.";
    return { error: message };
  }

  redirect(next);
}