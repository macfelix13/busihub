import Link from "next/link";
import { notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { PlanForm } from "../plan-form";
import type { PlanFeatureFlags, PlanLimits } from "@/lib/entitlements/limits";

export const metadata = { title: "Edit plan — Busihub Admin" };

interface PlanRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  price_amount: string;
  currency_code: string;
  billing_interval: string;
  limits: Partial<PlanLimits> | null;
  is_active: boolean;
  sort_order: number;
}

/**
 * Defensive against a plan whose limits jsonb predates a key this app now
 * knows about (or was hand-edited in the SQL editor before this page
 * existed) — every field the form renders gets a real default rather than
 * `undefined`, which React would otherwise render as an uncontrolled ->
 * controlled input warning.
 */
function normalizeLimits(limits: Partial<PlanLimits> | null): PlanLimits {
  // Typed as Partial<PlanFeatureFlags>, not PlanFeatureFlags — an empty
  // object literal `{}` satisfies that (every property optional), which
  // is exactly what's needed when limits.features itself is missing.
  // Falling back to `{}` against the full PlanFeatureFlags type instead
  // (the bug npm run typecheck/build both caught) makes `features` widen
  // to `PlanFeatureFlags | {}`, and TypeScript won't let you read
  // `.advanced_reports` off a bare `{}` even though every real branch of
  // that union has it.
  const features: Partial<PlanFeatureFlags> = limits?.features ?? {};
  return {
    max_users: limits?.max_users ?? null,
    max_branches: limits?.max_branches ?? null,
    max_products: limits?.max_products ?? null,
    max_pos_terminals: limits?.max_pos_terminals ?? null,
    storage_mb: limits?.storage_mb ?? null,
    features: {
      advanced_reports: features.advanced_reports ?? false,
      api_access: features.api_access ?? false,
      sms_notifications: features.sms_notifications ?? false,
    },
  };
}

export default async function EditPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();

  // Not filtered to is_active — a Super Admin editing (or reviving) an
  // already-retired plan is exactly the point of reaching this page from
  // /admin/plans's own list, which shows inactive plans too.
  const { data: plan, error } = await supabase
    .from("subscription_plans")
    .select("id, slug, name, description, price_amount, currency_code, billing_interval, limits, is_active, sort_order")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("EditPlanPage: plan query failed", error);
  }

  if (!plan) {
    notFound();
  }

  const row = plan as PlanRow;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/admin/plans" className="text-sm text-brand-700 hover:underline dark:text-brand-300">
          ← All plans
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{row.name}</h1>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card">
        <PlanForm
          plan={{
            id: row.id,
            slug: row.slug,
            name: row.name,
            description: row.description,
            priceAmount: row.price_amount,
            currencyCode: row.currency_code,
            billingInterval: row.billing_interval,
            limits: normalizeLimits(row.limits),
            isActive: row.is_active,
            sortOrder: row.sort_order,
          }}
        />
      </div>
    </div>
  );
}