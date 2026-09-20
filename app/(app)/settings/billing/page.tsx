import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { getSubscriptionSummary, getUsageCounts } from "@/lib/entitlements/queries";
import { daysUntil, graceDaysRemaining, resolveLimitCheck, type SubscriptionStatus } from "@/lib/entitlements/limits";
import { formatMoney, toMinorUnits, toNumber } from "@/lib/money/money";
import { supportEmail, supportPhone } from "@/lib/env";
import { verifyPlatformTransaction } from "@/lib/paystack/platform-client";
import { SubscribeButton } from "./subscribe-button";
import { cancelSubscription } from "./actions";
import { StatusToggleButton } from "@/app/(app)/products/status-toggle-button";

export const metadata = { title: "Billing" };

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  trialing: "Free trial",
  active: "Active",
  past_due: "Trial ended",
  suspended: "Suspended",
  cancelled: "Cancelled",
  expired: "Expired",
};

const STATUS_BADGE: Record<SubscriptionStatus, string> = {
  trialing: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  active: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  past_due: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  // Reachable in the query, even though app/(app)/layout.tsx already
  // locks these three statuses out of every route under (app) —
  // defensive, not dead code: a status could change between this page's
  // own permission check and its query running.
  suspended: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  cancelled: "bg-neutral-100 text-neutral-600 dark:bg-surface dark:text-ink-muted",
  expired: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

const USAGE_ROWS: { key: "branches" | "users" | "products"; label: string; limitKey: "max_branches" | "max_users" | "max_products" }[] = [
  { key: "branches", label: "Branches", limitKey: "max_branches" },
  { key: "users", label: "Staff accounts", limitKey: "max_users" },
  { key: "products", label: "Products & services", limitKey: "max_products" },
];

interface OtherPlanRow {
  id: string;
  name: string;
  price_amount: string;
  currency_code: string;
  billing_interval: string;
}

export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; reference?: string; trxref?: string }>;
}) {
  const { checkout, reference, trxref } = await searchParams;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.BUSINESS_MANAGE);

  // Owner-only, same reasoning as Settings → Business (business.manage
  // isn't in any other seeded role's permission set) — both the plan a
  // business is on and how much of it is used are ownership-level
  // information, not something every cashier needs to see.
  if (!canManage) {
    redirect("/dashboard");
  }

  const [subscription, usage] = await Promise.all([
    getSubscriptionSummary(supabase, businessId),
    getUsageCounts(supabase, businessId),
  ]);

  // Only offered when NOT already on an active, Paystack-managed
  // subscription — switching from one self-serve plan to another is
  // deliberately out of scope for this delivery (migration 0061's own
  // header explains why). A trialing/past_due/expired/cancelled business,
  // or one a Super Admin put on an active plan by hand with no Paystack
  // link at all, still sees the picker.
  const alreadySelfServeActive = subscription?.status === "active" && Boolean(subscription.paystackSubscriptionCode);

  let otherPlans: OtherPlanRow[] = [];
  if (!alreadySelfServeActive) {
    let query = supabase
      .from("subscription_plans")
      .select("id, name, price_amount, currency_code, billing_interval")
      .eq("is_active", true)
      .not("paystack_plan_code", "is", null)
      .order("sort_order", { ascending: true });
    if (subscription?.planId) {
      query = query.neq("id", subscription.planId);
    }
    const { data: planRows, error: plansError } = await query;
    if (plansError) {
      console.error("BillingSettingsPage: other-plans query failed", plansError);
    }
    otherPlans = (planRows ?? []) as OtherPlanRow[];
  }

  // Purely informational — never authoritative. The webhook
  // (app/api/webhooks/paystack-platform) is what actually activates the
  // subscription; this just gives the returning business an honest
  // "here's what Paystack told us just now" line while that catches up,
  // rather than a bare, unexplained redirect back to the same page.
  let checkoutBanner: { tone: "success" | "pending" | "failed"; message: string } | null = null;
  if (checkout === "return") {
    const ref = reference ?? trxref;
    const verified = ref ? await verifyPlatformTransaction(ref) : null;
    if (!verified) {
      checkoutBanner = {
        tone: "pending",
        message: "We're confirming this payment with Paystack — refresh in a moment if your plan doesn't update below.",
      };
    } else if (verified.status === "success") {
      checkoutBanner = {
        tone: alreadySelfServeActive ? "success" : "pending",
        message: alreadySelfServeActive
          ? "Payment received — this business is now on the new plan."
          : "Payment received. Activating your new plan — refresh in a moment if it doesn't show below yet.",
      };
    } else if (verified.status === "failed") {
      checkoutBanner = { tone: "failed", message: "This payment didn't go through, so nothing has changed. You can try again below." };
    } else {
      checkoutBanner = { tone: "pending", message: "This payment is still being processed by Paystack — refresh in a moment." };
    }
  }

  const email = supportEmail();
  const phone = supportPhone();
  const whatsappDigits = phone.replace(/[^0-9]/g, "");

  const trialDaysLeft = subscription?.trialEndsAt ? daysUntil(subscription.trialEndsAt) : null;
  const graceDaysLeft = subscription?.pastDueSince ? graceDaysRemaining(subscription.pastDueSince) : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="text-neutral-500 dark:text-ink-muted">Your plan, usage, and how to change either.</p>
      </div>

      {checkoutBanner ? (
        <p
          role="status"
          className={
            checkoutBanner.tone === "success"
              ? "rounded-xl bg-green-50 px-4 py-3 text-sm text-green-800 dark:bg-green-950/40 dark:text-green-200"
              : checkoutBanner.tone === "failed"
                ? "rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200"
                : "rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          }
        >
          {checkoutBanner.message}
        </p>
      ) : null}

      {!subscription ? (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          We couldn&apos;t find a subscription record for this business. Contact Busihub support below — this needs
          a Super Admin to fix, not something you can resolve from this page.
        </p>
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-surface-line dark:bg-surface-card">
            <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold">{subscription.plan?.name ?? "Unknown plan"}</h2>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[subscription.status]}`}>
                    {STATUS_LABEL[subscription.status]}
                  </span>
                </div>
                {subscription.plan ? (
                  <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
                    {toNumber(subscription.plan.priceAmount) === 0
                      ? "Free"
                      : `${formatMoney(toMinorUnits(subscription.plan.priceAmount), subscription.plan.currencyCode)} / ${subscription.plan.billingInterval}`}
                  </p>
                ) : null}
              </div>
            </div>

            <dl className="divide-y divide-neutral-100 border-t border-neutral-100 dark:divide-surface-line dark:border-surface-line">
              {subscription.status === "trialing" && subscription.trialEndsAt ? (
                <Row
                  label="Trial ends"
                  value={
                    trialDaysLeft !== null && trialDaysLeft >= 0
                      ? `${formatDate(subscription.trialEndsAt)} (${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"} left)`
                      : formatDate(subscription.trialEndsAt)
                  }
                />
              ) : null}
              {subscription.status === "past_due" ? (
                <Row
                  label="Grace period"
                  value={
                    graceDaysLeft !== null
                      ? `${graceDaysLeft} day${graceDaysLeft === 1 ? "" : "s"} left before this account is locked`
                      : "Ending very soon"
                  }
                />
              ) : null}
              {subscription.status === "active" && subscription.currentPeriodEnd ? (
                <Row
                  label={subscription.cancelAtPeriodEnd ? "Access ends" : "Renews"}
                  value={formatDate(subscription.currentPeriodEnd)}
                />
              ) : null}
            </dl>

            {alreadySelfServeActive ? (
              <div className="border-t border-neutral-100 px-5 py-4 dark:border-surface-line">
                {subscription.cancelAtPeriodEnd ? (
                  <p className="text-sm text-neutral-500 dark:text-ink-muted">
                    This subscription is set to end on{" "}
                    {subscription.currentPeriodEnd ? formatDate(subscription.currentPeriodEnd) : "its current period's end"}{" "}
                    and won&apos;t auto-renew — no further charge will be made.
                  </p>
                ) : (
                  <StatusToggleButton
                    action={cancelSubscription}
                    label="Cancel subscription"
                    pendingLabel="Cancelling…"
                    variant="danger"
                    confirm={{
                      title: "Cancel this subscription?",
                      description:
                        "This stops future auto-renewal through Paystack. Access continues until the current period ends — nothing is refunded and nothing is locked immediately.",
                      confirmLabel: "Cancel subscription",
                    }}
                  />
                )}
              </div>
            ) : null}
          </div>

          <div>
            <h2 className="font-semibold">Usage</h2>
            <div className="mt-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-surface-line dark:bg-surface-card">
              <dl className="divide-y divide-neutral-100 dark:divide-surface-line">
                {USAGE_ROWS.map(({ key, label, limitKey }) => {
                  const limit = subscription.plan?.limits?.[limitKey] ?? null;
                  const check = resolveLimitCheck(limit, usage[key]);
                  return (
                    <Row
                      key={key}
                      label={label}
                      value={check.limit === null ? `${usage[key]} used` : `${usage[key]} of ${check.limit} used`}
                    />
                  );
                })}
              </dl>
            </div>
          </div>

          {!alreadySelfServeActive && otherPlans.length > 0 ? (
            <div>
              <h2 className="font-semibold">Upgrade</h2>
              <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
                Subscribe with Paystack — your card or mobile money is charged automatically each period from then on.
              </p>
              <div className="mt-3 flex flex-col gap-3">
                {otherPlans.map((plan) => (
                  <div
                    key={plan.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-neutral-200 bg-white px-5 py-4 dark:border-surface-line dark:bg-surface-card"
                  >
                    <div>
                      <p className="font-medium">{plan.name}</p>
                      <p className="text-sm text-neutral-500 dark:text-ink-muted">
                        {formatMoney(toMinorUnits(plan.price_amount), plan.currency_code)} / {plan.billing_interval}
                      </p>
                    </div>
                    <SubscribeButton planId={plan.id} planName={plan.name} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}

      <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card">
        <h2 className="font-semibold">Have a billing question, or need a plan not listed above?</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
          Reach out and we&apos;ll sort it out — this also covers switching between two self-serve plans, which isn&apos;t
          self-serve yet.
        </p>
        <div className="mt-3 flex flex-col items-start gap-1 text-sm">
          <a href={`mailto:${email}`} className="text-brand-700 hover:underline dark:text-brand-300">
            {email}
          </a>
          <a
            href={`https://wa.me/${whatsappDigits}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-700 hover:underline dark:text-brand-300"
          >
            {phone} (WhatsApp)
          </a>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm font-medium text-neutral-500 dark:text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-neutral-800 dark:text-ink sm:col-span-2">{value}</dd>
    </div>
  );
}