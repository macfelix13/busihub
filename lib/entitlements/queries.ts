import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanLimits, SubscriptionStatus } from "./limits";

export interface SubscriptionSummary {
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pastDueSince: string | null;
  /** Set once Paystack's own subscription.create event confirms it (migration 0061) — a business on this plan by a Super Admin's own hand, or one that hasn't finished the self-serve checkout webhook flow yet, has this as null. Settings → Billing uses this (not just `status`) to decide whether to show the self-serve upgrade picker or the manage/cancel section. */
  paystackSubscriptionCode: string | null;
  /** The current plan's own id — used by Settings → Billing to exclude it from the "other plans" self-serve picker. Null only alongside `plan: null` (no subscription_plans row at all, shouldn't happen past register_business()). */
  planId: string | null;
  plan: {
    name: string;
    slug: string;
    /** numeric(14,2) column, comes back as a string over PostgREST — see lib/money/money.ts's toNumber() before doing arithmetic with it. */
    priceAmount: string;
    currencyCode: string;
    billingInterval: string;
    limits: PlanLimits;
  } | null;
}

export interface UsageCounts {
  branches: number;
  users: number;
  products: number;
}

interface SubscriptionRow {
  status: string;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  past_due_since: string | null;
  paystack_subscription_code: string | null;
  plan_id: string | null;
  subscription_plans: {
    name: string;
    slug: string;
    price_amount: string;
    currency_code: string;
    billing_interval: string;
    limits: PlanLimits;
  } | null;
}

/**
 * Reads a business's own subscription row + its plan in one round trip.
 * Returns null only if the business somehow has no subscription row at
 * all (shouldn't happen past register_business()) — callers must treat
 * that the same way 0058's app_plan_limits() does on the database side:
 * as "nothing to enforce/show", never as "locked out".
 *
 * RLS (business_subscriptions_select, 0009) already scopes this to the
 * caller's own business (or a Super Admin) — the businessId argument is
 * belt-and-suspenders, same convention as every other query in this app
 * that also filters explicitly rather than relying on RLS alone.
 */
export async function getSubscriptionSummary(
  supabase: SupabaseClient,
  businessId: string
): Promise<SubscriptionSummary | null> {
  const { data, error } = await supabase
    .from("business_subscriptions")
    .select(
      "status, trial_ends_at, current_period_start, current_period_end, cancel_at_period_end, past_due_since, paystack_subscription_code, plan_id, subscription_plans (name, slug, price_amount, currency_code, billing_interval, limits)"
    )
    .eq("business_id", businessId)
    .maybeSingle();

  if (error) {
    console.error("getSubscriptionSummary: query failed", error);
    return null;
  }
  if (!data) return null;

  const row = data as unknown as SubscriptionRow;

  return {
    status: row.status as SubscriptionStatus,
    trialEndsAt: row.trial_ends_at,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    pastDueSince: row.past_due_since,
    paystackSubscriptionCode: row.paystack_subscription_code,
    planId: row.plan_id,
    plan: row.subscription_plans
      ? {
          name: row.subscription_plans.name,
          slug: row.subscription_plans.slug,
          priceAmount: row.subscription_plans.price_amount,
          currencyCode: row.subscription_plans.currency_code,
          billingInterval: row.subscription_plans.billing_interval,
          limits: row.subscription_plans.limits,
        }
      : null,
  };
}

/**
 * Live counts behind the three limits 0058 actually enforces — 'active'
 * rows only, matching app_enforce_limit()'s own callers exactly
 * (enforce_branch_limit(), create_product(), invite_staff_member()) so
 * this page's "X of Y used" never disagrees with what the database
 * itself is counting.
 */
export async function getUsageCounts(supabase: SupabaseClient, businessId: string): Promise<UsageCounts> {
  const [{ count: branches }, { count: users }, { count: products }] = await Promise.all([
    supabase.from("branches").select("id", { count: "exact", head: true }).eq("business_id", businessId).eq("status", "active"),
    supabase.from("profiles").select("id", { count: "exact", head: true }).eq("business_id", businessId).eq("status", "active"),
    supabase.from("products").select("id", { count: "exact", head: true }).eq("business_id", businessId).eq("status", "active"),
  ]);

  return { branches: branches ?? 0, users: users ?? 0, products: products ?? 0 };
}