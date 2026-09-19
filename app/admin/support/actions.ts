"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSuperAdmin } from "@/lib/auth/is-super-admin";

/**
 * Re-checks isSuperAdmin() independently rather than trusting the page
 * that renders the button — same "cosmetic" relationship every other
 * Server Action in this app has with its own page's permission check
 * (Section 49). RLS's support_requests_update policy (0057,
 * `app_is_super_admin()`) is the real backstop underneath this either way.
 */
export async function resolveSupportRequest(requestId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();

  if (!(await isSuperAdmin(supabase))) {
    throw new Error("You don't have permission to perform this action.");
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("support_requests")
    .update({ status: "resolved", resolved_at: new Date().toISOString(), resolved_by: user?.id ?? null })
    .eq("id", requestId);

  if (error) {
    console.error("resolveSupportRequest: update failed", error);
    throw new Error("Couldn't resolve this request. Please try again.");
  }

  revalidatePath("/admin/support");
  revalidatePath("/admin");
}