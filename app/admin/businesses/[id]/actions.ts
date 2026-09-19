"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSuperAdmin } from "@/lib/auth/is-super-admin";

/**
 * Re-checks isSuperAdmin() independently rather than trusting that the
 * button which triggered this only ever renders inside /admin (Section
 * 49) — the same "cosmetic" relationship every other Server Action in
 * this app has with its page's own permission check. RLS's businesses_update
 * policy (0009, `app_has_permission(id, 'business.manage') or
 * app_is_super_admin()`) is the real backstop underneath this either way.
 */
async function requireSuperAdmin() {
  const supabase = await createServerSupabaseClient();
  if (!(await isSuperAdmin(supabase))) {
    throw new Error("You don't have permission to perform this action.");
  }
  return supabase;
}

async function setBusinessStatus(businessId: string, status: "active" | "suspended", action: string) {
  const supabase = await requireSuperAdmin();

  const { error } = await supabase.from("businesses").update({ status }).eq("id", businessId);

  if (error) {
    console.error(`${action}: update failed`, error);
    throw new Error("Couldn't update this business. Please try again.");
  }

  // First real caller of log_audit_event() (0008) — it has existed since
  // the earliest phases but nothing has ever written to audit_logs until
  // now. business_id is the business being acted ON, not the actor's own
  // (a Super Admin has none) — matches audit_logs' own comment that a
  // platform-level actor still names the business a row is about.
  const { error: auditError } = await supabase.rpc("log_audit_event", {
    p_business_id: businessId,
    p_branch_id: null,
    p_action: action,
    p_resource_type: "business",
    p_resource_id: businessId,
    p_metadata: {},
  });

  // A failed audit write should not silently look like a failed action to
  // the person who just suspended/reactivated a business — the mutation
  // above already succeeded. Logged, not thrown, so the flow still
  // completes; this is the one gap noted in the changelog as worth
  // revisiting if audit completeness ever becomes load-bearing.
  if (auditError) {
    console.error(`${action}: log_audit_event failed`, auditError);
  }

  revalidatePath("/admin/businesses");
  revalidatePath(`/admin/businesses/${businessId}`);
}

/**
 * Bound to a business id from the detail page (suspendBusiness.bind(null,
 * business.id)) and used directly as a <form action>, same no-useFormState
 * pattern as branches/set-main-branch-button.tsx.
 */
export async function suspendBusiness(businessId: string): Promise<void> {
  await setBusinessStatus(businessId, "suspended", "platform.business_suspended");
}

export async function reactivateBusiness(businessId: string): Promise<void> {
  await setBusinessStatus(businessId, "active", "platform.business_reactivated");
}

export interface SubscriptionFormState {
  error?: string;
  success?: boolean;
}

/**
 * Phase 18 (Subscriptions & entitlements enforcement, 0058) — the
 * hand-operated stand-in for real recurring billing (see that
 * migration's own file header). Everything that actually matters here
 * (plan slug must be real and active, status must be a real enum value,
 * the grace-period bookkeeping) happens inside
 * admin_set_business_subscription() itself, re-checking
 * app_is_super_admin() independently of this action, same as every
 * other Super Admin write in this file.
 */
export async function updateBusinessSubscription(
  businessId: string,
  _prevState: SubscriptionFormState,
  formData: FormData
): Promise<SubscriptionFormState> {
  const supabase = await requireSuperAdmin();

  const planSlug = String(formData.get("planSlug") ?? "");
  const status = String(formData.get("status") ?? "");
  const periodEndRaw = String(formData.get("currentPeriodEnd") ?? "");
  const cancelAtPeriodEnd = formData.get("cancelAtPeriodEnd") === "on";

  if (!planSlug || !status) {
    return { error: "Choose a plan and a status." };
  }

  // A bare "YYYY-MM-DD" from the date input, midnight UTC — good enough
  // for an administrative period-end marker (see 0058's file header on
  // why this isn't tied to a real billing cycle yet), not a precise
  // billing timestamp.
  const currentPeriodEnd = periodEndRaw ? new Date(periodEndRaw).toISOString() : null;

  const { error } = await supabase.rpc("admin_set_business_subscription", {
    p_business_id: businessId,
    p_plan_slug: planSlug,
    p_status: status,
    p_current_period_end: currentPeriodEnd,
    p_cancel_at_period_end: cancelAtPeriodEnd,
  });

  if (error) {
    console.error("updateBusinessSubscription: rpc failed", error);
    // P0002 (unknown/inactive plan) and 22023 (unknown status) are the
    // function's own friendly, user-facing messages — safe to forward
    // verbatim, same convention app/(app)/branches/actions.ts and
    // app/(app)/products/actions.ts already use for their own raised
    // errors. Anything else is an unexpected failure, not shown raw
    // (Section 38).
    const friendly = error.code === "P0002" || error.code === "22023" ? error.message : "Couldn't update this business's subscription. Please try again.";
    return { error: friendly };
  }

  revalidatePath(`/admin/businesses/${businessId}`);
  return { success: true };
}