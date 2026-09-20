import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { formatMoney, toMinorUnits, toNumber } from "@/lib/money/money";

export const metadata = { title: "Plans — Busihub Admin" };

interface PlanRow {
  id: string;
  slug: string;
  name: string;
  price_amount: string;
  currency_code: string;
  billing_interval: string;
  is_active: boolean;
  sort_order: number;
}

/**
 * The catalog list behind Phase 18's plan-assignment form
 * (app/admin/businesses/[id]/subscription-form.tsx) — until 0059, this
 * table had no UI of its own at all, only ever seeded by migration 0010.
 * Deliberately shows inactive plans too (unlike the assignment dropdown,
 * which filters to is_active) — a Super Admin retiring or reviving a plan
 * needs to see it either way, same reasoning as
 * app/admin/businesses/page.tsx's own "all" status filter.
 */
export default async function AdminPlansPage() {
  const supabase = await createServerSupabaseClient();

  const { data: planRows, error } = await supabase
    .from("subscription_plans")
    .select("id, slug, name, price_amount, currency_code, billing_interval, is_active, sort_order")
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("AdminPlansPage: plans query failed", error);
  }

  const plans = (planRows ?? []) as PlanRow[];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Plans</h1>
          <p className="text-neutral-500 dark:text-ink-muted">
            The subscription plan catalog — every business is assigned one of these from its own page.
          </p>
        </div>
        <Link href="/admin/plans/new">
          <Button>New plan</Button>
        </Link>
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load plans. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-surface-line dark:bg-surface-card">
          <ul className="divide-y divide-neutral-100 dark:divide-surface-line">
            {plans.length > 0 ? (
              plans.map((plan) => (
                <li key={plan.id}>
                  <Link
                    href={`/admin/plans/${plan.id}`}
                    className="flex flex-col gap-2 px-5 py-4 hover:bg-neutral-50 sm:flex-row sm:items-center sm:justify-between dark:hover:bg-surface/60"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{plan.name}</span>
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-surface dark:text-ink-muted">
                          {plan.slug}
                        </span>
                        {!plan.is_active ? (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                            Inactive
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex-shrink-0 text-sm text-neutral-500 dark:text-ink-muted sm:text-right">
                      {toNumber(plan.price_amount) > 0
                        ? `${formatMoney(toMinorUnits(plan.price_amount), plan.currency_code)} / ${plan.billing_interval}`
                        : "Free"}
                    </div>
                  </Link>
                </li>
              ))
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500 dark:text-ink-muted">No plans yet.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}