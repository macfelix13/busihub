import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { resolvePeriod, periodDates, type Period } from "@/lib/reports/period";
import type { BranchOption } from "./report-shell";

/**
 * The setup every report page repeats: who is asking, which shop, which
 * branch, which period, and how to write money.
 *
 * Gathered in one place so the four report pages differ only in the
 * figures they fetch — and so a change to how a branch id from the URL
 * is validated happens once rather than four times, three of which would
 * eventually be missed.
 */

export interface ReportSearchParams {
  range?: string;
  from?: string;
  to?: string;
  branch?: string;
}

export interface ReportContext {
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>;
  businessId: string;
  shopName: string;
  currencyCode: string;
  canView: boolean;
  canExport: boolean;
  branches: BranchOption[];
  /** Null means every branch this person can see. */
  branchId: string | null;
  branchLabel: string | null;
  period: Period;
  /** The period's endpoints as local YYYY-MM-DD dates. */
  fromDate: string;
  toDate: string;
  money: (amount: number | string | null | undefined) => string;
}

export async function loadReportContext(params: ReportSearchParams): Promise<ReportContext> {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canView, canExport, { data: business }, { data: branchRows }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.REPORTS_VIEW),
    hasPermission(supabase, businessId, PERMISSIONS.REPORTS_EXPORT),
    supabase.from("businesses").select("name, currency_code").eq("id", businessId).maybeSingle(),
    supabase
      .from("branches")
      .select("id, name, is_main, timezone")
      .eq("status", "active")
      .order("is_main", { ascending: false }),
  ]);

  const allBranches = (branchRows ?? []) as unknown as {
    id: string;
    name: string;
    is_main: boolean;
    timezone: string | null;
  }[];

  // A branch id from the URL is honoured only if it is one this person
  // can already see. RLS returns nothing for anyone else's branch
  // regardless; this makes the page say "all branches" rather than
  // showing a page of zeroes with no explanation.
  const branchId = allBranches.some((b) => b.id === params.branch) ? params.branch! : null;
  const selected = allBranches.find((b) => b.id === branchId) ?? null;
  const main = allBranches.find((b) => b.is_main) ?? allBranches[0] ?? null;
  const period = resolvePeriod(params, selected?.timezone ?? main?.timezone);
  const { from: fromDate, to: toDate } = periodDates(period);

  const currencyCode = business?.currency_code ?? "GHS";

  return {
    supabase,
    businessId,
    shopName: business?.name ?? "Busihub",
    currencyCode,
    canView,
    canExport,
    branches: allBranches.map((b) => ({ id: b.id, name: b.name })),
    branchId,
    branchLabel: selected?.name ?? null,
    period,
    fromDate,
    toDate,
    money: (amount) => formatMoney(toMinorUnits(amount ?? 0), currencyCode),
  };
}

/** The query string that reproduces this view, for the CSV link. */
export function exportHref(report: string, context: ReportContext): string {
  const params = new URLSearchParams({ report, from: context.fromDate, to: context.toDate });
  if (context.branchId) params.set("branch", context.branchId);
  return `/reports/export?${params.toString()}`;
}