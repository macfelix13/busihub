"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { initializeSubscriptionCheckout, disableSubscription } from "@/lib/paystack/platform-client";
import { supabaseAppUrl } from "@/lib/env";
import { toMinorUnits } from "@/lib/money/money";

export interface StartCheckoutResult {
  authorizationUrl?: string;
  error?: string;
}

/**
 * Starts a self-serve upgrade. start_plan_checkout() (migration 0061)
 * re-checks business.manage and that the plan is active AND already
 * linked to Paystack itself — this action's own permission check is a
 * courtesy for a fast, friendly error, never the real boundary. Nothing
 * here flips the business onto the new plan: only the platform webhook
 * (app/api/webhooks/paystack-platform), once Paystack actually confirms
 * the charge, does that — the redirect this returns is not itself proof
 * of payment, same "never trust the client for money" rule as every
 * other payment path in this app.
 */
export async function startPlanCheckout(planId: string): Promise<StartCheckoutResult> {
  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await getCurrentBusinessId(supabase);
    await requirePermission(supabase, businessId, PERMISSIONS.BUSINESS_MANAGE);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("startPlanCheckout: permission lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    return { error: "Your account has no email on file — contact Busihub support." };
  }

  const { data: reference, error: refError } = await supabase.rpc("start_plan_checkout", { p_plan_id: planId });
  if (refError) {
    console.error("startPlanCheckout: start_plan_checkout rpc failed", refError);
    const friendly =
      refError.code === "P0002" || refError.code === "P0001" ? refError.message : "Couldn't start checkout. Please try again.";
    return { error: friendly };
  }

  // A plain select, not another RPC — subscription_plans_select (0009)
  // already lets any authenticated caller read an active plan's columns,
  // and start_plan_checkout() above already confirmed this exact plan is
  // active and linked before handing back a reference. price_amount and
  // currency_code are read here too, not just paystack_plan_code — Paystack's
  // /transaction/initialize rejects the request outright ("Invalid amount
  // sent") without an amount, even when a plan code is also passed, so
  // initializeSubscriptionCheckout needs the plan's own price to send
  // along with it (see that function's own comment for how this was found).
  const { data: plan, error: planError } = await supabase
    .from("subscription_plans")
    .select("paystack_plan_code, price_amount, currency_code")
    .eq("id", planId)
    .maybeSingle();

  const planRow = plan as { paystack_plan_code: string | null; price_amount: number | string; currency_code: string } | null;
  const planCode = planRow?.paystack_plan_code ?? null;
  if (planError || !planRow || !planCode) {
    console.error("startPlanCheckout: plan has no Paystack code after start_plan_checkout succeeded", { planError, planId });
    return { error: "This plan isn't available for self-serve upgrade right now." };
  }

  const result = await initializeSubscriptionCheckout({
    email: user.email,
    planCode,
    amountMinorUnits: toMinorUnits(planRow.price_amount),
    currencyCode: planRow.currency_code,
    reference: String(reference),
    callbackUrl: `${supabaseAppUrl()}/settings/billing?checkout=return`,
    // Redundant with the checkout row itself (the webhook matches by
    // reference, not by this) — kept only as a defensive cross-check
    // available if it's ever needed, never relied on as the primary match.
    metadata: { business_id: businessId, plan_id: planId },
  });

  if (!result.ok || !result.authorizationUrl) {
    console.error("startPlanCheckout: Paystack initialize failed", result.message);
    return { error: result.message ?? "Couldn't start checkout with Paystack. Please try again." };
  }

  return { authorizationUrl: result.authorizationUrl };
}

/**
 * Asks Paystack to stop future auto-renewal — never touches
 * business_subscriptions directly. The actual cancel_at_period_end flip
 * happens once Paystack's own subscription.disable webhook arrives
 * (platform_billing_record_cancel_scheduled(), migration 0061); this
 * action only makes the request and logs a failure server-side if
 * Paystack refuses it. There is deliberately no error surfaced back to
 * the button on failure (StatusToggleButton's bound-action shape doesn't
 * carry a return value to the UI, same as every other status-toggle
 * action in this app) — a genuine Paystack rejection here is rare
 * (the code/token pair came from our own stored, already-confirmed
 * subscription), and the button is safe to press again either way.
 */
export async function cancelSubscription(): Promise<void> {
  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await getCurrentBusinessId(supabase);
    await requirePermission(supabase, businessId, PERMISSIONS.BUSINESS_MANAGE);
  } catch (err) {
    console.error("cancelSubscription: permission check failed", err);
    return;
  }

  const { data: subscription, error } = await supabase
    .from("business_subscriptions")
    .select("paystack_subscription_code, paystack_email_token")
    .eq("business_id", businessId)
    .maybeSingle();

  if (error) {
    console.error("cancelSubscription: subscription lookup failed", error);
    return;
  }

  const row = subscription as { paystack_subscription_code: string | null; paystack_email_token: string | null } | null;
  if (!row?.paystack_subscription_code || !row.paystack_email_token) {
    console.error("cancelSubscription: no Paystack subscription linked to this business", businessId);
    return;
  }

  const result = await disableSubscription({ code: row.paystack_subscription_code, token: row.paystack_email_token });
  if (!result.ok) {
    console.error("cancelSubscription: Paystack disable failed", result.message);
  }

  // Harmless either way: if the webhook has already landed by the time
  // this returns, the page picks up the real state; if not, the next
  // load just shows what it showed before, until it does.
  revalidatePath("/settings/billing");
}