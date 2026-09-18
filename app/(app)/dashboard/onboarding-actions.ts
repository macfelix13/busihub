"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";

/**
 * Hides the first-run onboarding checklist (0053) for good. Gated by
 * business.manage — the same permission business_settings_update (0009)
 * already requires for any write to this table — so a cashier who
 * happens to see the checklist can't hide it for the owner too; the
 * button that calls this is only ever rendered for someone who already
 * has the permission (cosmetic gate), and this is the real one.
 *
 * A plain replace, not a merge: onboarding_settings only has one key
 * today ({"dismissed": bool}), so there's nothing to preserve. If a
 * second key is ever added to that jsonb column, this needs to become a
 * merge (`onboarding_settings || '{"dismissed": true}'`) instead —
 * flagged here rather than silently built for a merge scenario that
 * doesn't exist yet.
 */
export async function dismissOnboardingChecklist(): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, PERMISSIONS.BUSINESS_MANAGE);

  const { error } = await supabase
    .from("business_settings")
    .update({ onboarding_settings: { dismissed: true } })
    .eq("business_id", businessId);

  if (error) {
    console.error("dismissOnboardingChecklist: update failed", error);
    throw new Error("Couldn't hide the checklist. Please try again.");
  }

  revalidatePath("/dashboard");
}