"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSuperAdmin } from "@/lib/auth/is-super-admin";
import { createOrUpdatePaystackPlan, type PaystackPlanInterval } from "@/lib/paystack/platform-client";
import { toMinorUnits } from "@/lib/money/money";

/**
 * Re-checks isSuperAdmin() independently rather than trusting the page
 * that renders the form — same "cosmetic" relationship every other
 * Server Action in this app has with its own page's permission check
 * (Section 49, see app/admin/businesses/[id]/actions.ts). RLS
 * (subscription_plans_write, 0009) and admin_upsert_subscription_plan()'s
 * own app_is_super_admin() check (0059) are the real backstops underneath
 * this either way.
 */
async function requireSuperAdmin() {
  const supabase = await createServerSupabaseClient();
  if (!(await isSuperAdmin(supabase))) {
    throw new Error("You don't have permission to perform this action.");
  }
  return supabase;
}

export interface PlanFormState {
  error?: string;
}

const NUMERIC_LIMIT_KEYS = ["max_users", "max_branches", "max_products", "max_pos_terminals", "storage_mb"] as const;
const FEATURE_KEYS = ["advanced_reports", "api_access", "sms_notifications"] as const;

/**
 * Turns the plan-form's flat fields (one text input per numeric limit,
 * left blank for "unlimited"; one checkbox per feature flag) into the
 * jsonb shape subscription_plans.limits actually stores (0006/0010) — the
 * form never constructs or edits jsonb text directly, so there's no way
 * for a stray character to produce something that parses but means the
 * wrong thing.
 */
function buildLimitsJson(formData: FormData): Record<string, unknown> {
  const limits: Record<string, unknown> = {};

  for (const key of NUMERIC_LIMIT_KEYS) {
    const raw = String(formData.get(`limit_${key}`) ?? "").trim();
    limits[key] = raw === "" ? null : Number(raw);
  }

  const features: Record<string, boolean> = {};
  for (const key of FEATURE_KEYS) {
    features[key] = formData.get(`feature_${key}`) === "on";
  }
  limits.features = features;

  return limits;
}

/**
 * Only 'month' and 'year' map to a Paystack billing interval — 'none'
 * (the free/one-time convention this codebase already uses for the trial
 * plan, see 0010's seed data) has nothing for Paystack's Plan API to
 * charge on a schedule, so it is never synced at all. A price of exactly
 * 0 is excluded for the same reason regardless of interval: nothing
 * self-serve should ever charge a business GHS 0 on a recurring basis.
 */
function paystackIntervalFor(billingInterval: string): PaystackPlanInterval | null {
  if (billingInterval === "month") return "monthly";
  if (billingInterval === "year") return "annually";
  return null;
}

/**
 * Best-effort sync to Busihub's own Paystack account (lib/paystack/platform-client.ts)
 * — deliberately never throws and never blocks the plan save itself (the
 * plan's own fields still save via admin_upsert_subscription_plan even
 * when this fails). A plan that fails to sync just isn't offered on the
 * self-serve checkout page (migration 0061); it can still be assigned to
 * a business by hand today, exactly as it already can be.
 *
 * Returns both the paystack_plan_code to store (the freshly-synced one,
 * null if this plan isn't syncable at all, or the existing one unchanged
 * if a sync attempt failed) AND, when a sync was actually attempted and
 * failed, the reason why. Until this, that reason was only ever
 * console.error()'d — the Super Admin saw the save "succeed" (redirected
 * back to /admin/plans as normal) with no indication anything went wrong,
 * and the only visible symptom was the plan quietly staying "Not linked
 * to Paystack" on that list with no explanation. syncError lets the
 * caller surface it instead.
 */
async function resolvePaystackPlanCode(params: {
  existingCode: string | null;
  name: string;
  description: string | null;
  priceAmount: number;
  currencyCode: string;
  billingInterval: string;
}): Promise<{ planCode: string | null; syncError: string | null }> {
  const { existingCode, name, description, priceAmount, currencyCode, billingInterval } = params;
  const interval = paystackIntervalFor(billingInterval);

  if (interval === null || priceAmount <= 0) {
    return { planCode: null, syncError: null };
  }

  const result = await createOrUpdatePaystackPlan({
    existingPlanCode: existingCode,
    name,
    amountMinorUnits: toMinorUnits(priceAmount),
    interval,
    currencyCode,
    description,
  });

  if (!result.ok) {
    console.error("resolvePaystackPlanCode: Paystack sync failed, keeping existing code", {
      existingCode,
      message: result.message,
    });
    return { planCode: existingCode, syncError: result.message ?? "Paystack didn't say why." };
  }

  return { planCode: result.planCode, syncError: null };
}

/**
 * Bound to an existing plan's id from the edit page (upsertSubscriptionPlan.bind(null, plan.id))
 * or to null from the "New plan" page — mirrors updateBusinessSubscription's
 * own bind-then-useFormState shape (app/admin/businesses/[id]/actions.ts).
 * Every real validation (slug format, duplicate slug, billing_interval,
 * every limits key/value) happens inside admin_upsert_subscription_plan()
 * itself (0059) — this action only shapes the form's fields into the
 * RPC's parameters and forwards its own, already-friendly error messages.
 */
export async function upsertSubscriptionPlan(
  planId: string | null,
  _prevState: PlanFormState,
  formData: FormData
): Promise<PlanFormState> {
  const supabase = await requireSuperAdmin();

  const slug = String(formData.get("slug") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const priceAmountRaw = String(formData.get("priceAmount") ?? "").trim();
  const currencyCode = String(formData.get("currencyCode") ?? "").trim().toUpperCase();
  const billingInterval = String(formData.get("billingInterval") ?? "");
  const isActive = formData.get("isActive") === "on";
  const sortOrderRaw = String(formData.get("sortOrder") ?? "").trim();

  if (!slug || !name || !currencyCode || !billingInterval) {
    return { error: "Slug, name, currency, and billing interval are all required." };
  }

  const priceAmount = priceAmountRaw === "" ? 0 : Number(priceAmountRaw);
  if (!Number.isFinite(priceAmount)) {
    return { error: "Price must be a number." };
  }

  const sortOrder = sortOrderRaw === "" ? 0 : Number.parseInt(sortOrderRaw, 10);
  if (!Number.isFinite(sortOrder)) {
    return { error: "Sort order must be a whole number." };
  }

  // Read the plan's own current Paystack link, if it has one, BEFORE
  // deciding whether to create a new Paystack Plan or update the existing
  // one — a plain .select() rather than a new RPC, since subscription_plans_select
  // (0009) already lets a Super Admin read any row.
  let existingPaystackPlanCode: string | null = null;
  if (planId) {
    const { data: existingPlan, error: existingPlanError } = await supabase
      .from("subscription_plans")
      .select("paystack_plan_code")
      .eq("id", planId)
      .maybeSingle();
    if (existingPlanError) {
      console.error("upsertSubscriptionPlan: existing plan lookup failed", existingPlanError);
    }
    existingPaystackPlanCode = (existingPlan as { paystack_plan_code: string | null } | null)?.paystack_plan_code ?? null;
  }

  const { planCode: paystackPlanCode, syncError: paystackSyncError } = await resolvePaystackPlanCode({
    existingCode: existingPaystackPlanCode,
    name,
    description: description || null,
    priceAmount,
    currencyCode,
    billingInterval,
  });

  const { error } = await supabase.rpc("admin_upsert_subscription_plan", {
    p_id: planId,
    p_slug: slug,
    p_name: name,
    p_description: description || null,
    p_price_amount: priceAmount,
    p_currency_code: currencyCode,
    p_billing_interval: billingInterval,
    p_limits: buildLimitsJson(formData),
    p_is_active: isActive,
    p_sort_order: sortOrder,
    p_paystack_plan_code: paystackPlanCode,
  });

  if (error) {
    console.error("upsertSubscriptionPlan: rpc failed", error);
    // 22023 (invalid slug/limits/etc.), 23505 (duplicate slug), and P0002
    // (unknown plan id on an edit) are admin_upsert_subscription_plan's
    // own friendly, user-facing messages (0059) — safe to forward
    // verbatim, same convention as updateBusinessSubscription's own error
    // handling (app/admin/businesses/[id]/actions.ts).
    const friendly =
      error.code === "22023" || error.code === "23505" || error.code === "P0002"
        ? error.message
        : "Couldn't save this plan. Please try again.";
    return { error: friendly };
  }

  revalidatePath("/admin/plans");
  if (planId) {
    revalidatePath(`/admin/plans/${planId}`);
  }
  // Every business's plan-assignment dropdown (app/admin/businesses/[id]/page.tsx)
  // and Settings -> Billing page (app/(app)/settings/billing/page.tsx) read
  // subscription_plans too — Next's cache has no tag for "any page that
  // reads this table", so this is the same all-affected-paths tradeoff
  // suspendBusiness/reactivateBusiness already accept for /admin/businesses.
  revalidatePath("/admin/businesses");

  // The plan's own fields (name, price, limits, etc.) are saved either
  // way at this point — admin_upsert_subscription_plan already succeeded
  // above. This only reports whether the SEPARATE Paystack sync attempted
  // just above also worked, so a sync failure (missing/invalid platform
  // key, Paystack rejecting the request, a network error reaching
  // Paystack) is something the Super Admin actually sees, instead of a
  // silent redirect that looks identical to full success while the plan
  // quietly stays "Not linked to Paystack".
  if (paystackSyncError) {
    redirect(`/admin/plans?paystackError=${encodeURIComponent(paystackSyncError)}`);
  }

  redirect("/admin/plans");
}