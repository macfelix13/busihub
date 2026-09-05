import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { paymentMethodLabel } from "@/lib/validation/sales";
import { RANGES, resolvePeriod, periodDates } from "@/lib/reports/period";
import { SalesChart, type TrendPoint } from "./sales-chart";

export const metadata = { title: "Dashboard" };

/**
 * The dashboard.
 *
 * Every figure on this page comes from a database function that runs as
 * the signed-in user, so Row Level Security decides what is counted (see
 * migrations 0027, 0028, 0029, 0030). There is no business id in this
 * file and none in any query: the browser cannot name a business, and
 * naming someone else's branch in the URL returns nothing rather than
 * their takings — asserted in tests/security/dashboard.sql.
 *
 * Permission gating here is a SECOND layer, not the enforcement. Hiding
 * the takings card from a cashier is a courtesy; the reason a cashier
 * cannot read the takings is that sales_summary runs under their own RLS
 * and the money columns are permission-gated in the database. Deleting
 * every `canSeeMoney` check in this file would change what is drawn, not
 * what can be obtained.
 *
 * NET PROFIT
 *
 * Real since Phase 13: gross profit (sales less what the goods cost,
 * from 0029) minus recorded expenses (0031). Both halves are aggregates
 * the database computed over whole tables; the only arithmetic done here
 * is the subtraction, which is why it is safe to do in the page.
 *
 * It is shown ONLY to someone who can see both halves. A person with
 * reports.view but not expenses.view would otherwise be handed a "net
 * profit" that is really gross profit — the exact mislabelling this page
 * spent the previous phase avoiding.
 */

interface SummaryRow {
  sale_count: number | string;
  gross_total: number | string;
  refunded_total: number | string;
  net_total: number | string;
  cost_total: number | string;
  gross_profit: number | string;
  items_sold: number | string;
  any_cost_estimated: boolean;
}

interface SnapshotRow {
  owed_total: number | string;
  owing_customers: number | string;
  low_stock_count: number | string;
  awaiting_payment_count: number | string;
  low_stock_threshold: number | string;
}

interface RecentSale {
  id: string;
  receipt_number: string;
  status: string;
  payment_method: string;
  total: number | string;
  created_at: string;
  cashier: { first_name: string | null; last_name: string | null } | null;
}

interface BranchRow {
  id: string;
  name: string;
  is_main: boolean;
  timezone: string | null;
}

const SEVERITY_STYLES: Record<string, string> = {
  out: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  critical: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  low: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

const SEVERITY_LABELS: Record<string, string> = {
  out: "Out of stock",
  critical: "Critical",
  low: "Low",
};

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900 ${className}`}
    >
      {children}
    </section>
  );
}

function staffName(first: string | null, last: string | null): string {
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : "Unnamed user";
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string; branch?: string }>;
}) {
  const params = await searchParams;

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [
    canSell,
    canReport,
    canViewInventory,
    canViewCustomers,
    canViewExpenses,
    { data: business },
    { data: branchRows },
  ] =
    await Promise.all([
      hasPermission(supabase, businessId, PERMISSIONS.SALES_PROCESS),
      hasPermission(supabase, businessId, PERMISSIONS.REPORTS_VIEW),
      hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_VIEW),
      hasPermission(supabase, businessId, PERMISSIONS.CUSTOMERS_VIEW),
      hasPermission(supabase, businessId, PERMISSIONS.EXPENSES_VIEW),
      supabase.from("businesses").select("name, currency_code").eq("id", businessId).maybeSingle(),
      supabase.from("branches").select("id, name, is_main, timezone").eq("status", "active").order("is_main", {
        ascending: false,
      }),
    ]);

  const branches = (branchRows ?? []) as unknown as BranchRow[];

  // A branch id from the URL is only honoured if it is one of the
  // branches this user can already see. RLS would return nothing for
  // anyone else's branch anyway; this makes the page say "all branches"
  // instead of silently showing zeroes.
  const branchId = branches.some((b) => b.id === params.branch) ? params.branch! : null;
  const selectedBranch = branches.find((b) => b.id === branchId) ?? null;
  const mainBranch = branches.find((b) => b.is_main) ?? branches[0] ?? null;
  const period = resolvePeriod(params, selectedBranch?.timezone ?? mainBranch?.timezone);

  const currencyCode = business?.currency_code ?? "GHS";
  const money = (amount: number | string | undefined) => formatMoney(toMinorUnits(amount ?? 0), currencyCode);

  // Takings are a money figure: a cashier processes sales without
  // necessarily being trusted with the day's totals, so this is
  // reports.view — the same permission the sales history uses.
  const canSeeMoney = canReport;
  const fromIso = period.from.toISOString();
  const toIso = period.to.toISOString();
  // Expenses are booked to a day, not an instant — see periodDates().
  const { from: fromDate, to: toDate } = periodDates(period);

  const empty = Promise.resolve({ data: null, error: null });

  const [
    { data: summaryRows, error: summaryError },
    { data: snapshotRows, error: snapshotError },
    { data: trendRows, error: trendError },
    { data: paymentRows },
    { data: productRows },
    { data: lowStockRows },
    { data: staffRows },
    { data: branchPerfRows },
    { data: expenseRows },
    { data: expenseCategoryRows },
    { data: recent, error: recentError },
  ] = await Promise.all([
    canSeeMoney
      ? supabase.rpc("sales_summary", { p_from: fromIso, p_to: toIso, p_status: null, p_branch_id: branchId })
      : empty,
    supabase.rpc("dashboard_snapshot"),
    canSeeMoney
      ? supabase.rpc("sales_trend", {
          p_from: fromIso,
          p_to: toIso,
          p_branch_id: branchId,
          p_bucket: period.bucket,
          p_timezone: period.timezone,
        })
      : empty,
    canSeeMoney
      ? supabase.rpc("payment_method_breakdown", { p_from: fromIso, p_to: toIso, p_branch_id: branchId })
      : empty,
    canSeeMoney
      ? supabase.rpc("top_products", { p_from: fromIso, p_to: toIso, p_branch_id: branchId, p_limit: 5 })
      : empty,
    canViewInventory ? supabase.rpc("low_stock_report", { p_branch_id: branchId, p_limit: 6 }) : empty,
    canSeeMoney
      ? supabase.rpc("staff_performance", { p_from: fromIso, p_to: toIso, p_branch_id: branchId, p_limit: 5 })
      : empty,
    canSeeMoney && branches.length > 1
      ? supabase.rpc("branch_performance", { p_from: fromIso, p_to: toIso })
      : empty,
    canViewExpenses
      ? supabase.rpc("expense_summary", { p_from: fromDate, p_to: toDate, p_branch_id: branchId })
      : empty,
    canViewExpenses
      ? supabase.rpc("expenses_by_category", {
          p_from: fromDate,
          p_to: toDate,
          p_branch_id: branchId,
          p_limit: 5,
        })
      : empty,
    supabase
      .from("sales")
      .select(
        "id, receipt_number, status, payment_method, total, created_at, cashier:profiles!sales_cashier_id_fkey(first_name, last_name)"
      )
      .order("created_at", { ascending: false })
      .limit(6),
  ]);

  // Logged, not shown. A database error message can name columns,
  // functions and constraints, and none of that belongs on a shop's
  // screen — the page degrades to "couldn't load this" instead.
  if (summaryError) console.error("DashboardPage: summary failed", summaryError);
  if (snapshotError) console.error("DashboardPage: snapshot failed", snapshotError);
  if (trendError) console.error("DashboardPage: trend failed", trendError);
  if (recentError) console.error("DashboardPage: recent sales failed", recentError);

  const summary = ((summaryRows ?? []) as unknown as SummaryRow[])[0];
  const snapshot = ((snapshotRows ?? []) as unknown as SnapshotRow[])[0];
  const trend = (trendRows ?? []) as unknown as TrendPoint[];
  const payments = (paymentRows ?? []) as unknown as {
    method: string;
    tender_count: number | string;
    amount: number | string;
  }[];
  const products = (productRows ?? []) as unknown as {
    variant_id: string;
    product_name: string;
    sku: string | null;
    quantity_sold: number | string;
    revenue: number | string;
    gross_profit: number | string;
  }[];
  const lowStock = (lowStockRows ?? []) as unknown as {
    variant_id: string;
    branch_name: string;
    product_name: string;
    sku: string | null;
    quantity: number | string;
    reorder_point: number | string;
    severity: string;
  }[];
  const staff = (staffRows ?? []) as unknown as {
    cashier_id: string;
    first_name: string | null;
    last_name: string | null;
    sale_count: number | string;
    gross_total: number | string;
    refunded_total: number | string;
    net_total: number | string;
  }[];
  const branchPerf = (branchPerfRows ?? []) as unknown as {
    branch_id: string;
    branch_name: string;
    is_main: boolean;
    sale_count: number | string;
    net_total: number | string;
    gross_profit: number | string;
  }[];
  const expenses = ((expenseRows ?? []) as unknown as {
    expense_total: number | string;
    expense_count: number | string;
    cash_paid_out: number | string;
  }[])[0];
  const expenseCategories = (expenseCategoryRows ?? []) as unknown as {
    category_id: string | null;
    category_name: string;
    amount: number | string;
    expense_count: number | string;
  }[];
  const recentSales = (recent ?? []) as unknown as RecentSale[];

  const waiting = Number(snapshot?.awaiting_payment_count ?? 0);
  const owed = Number(snapshot?.owed_total ?? 0);
  const saleCount = Number(summary?.sale_count ?? 0);
  const netTotal = Number(summary?.net_total ?? 0);
  const averageSale = saleCount > 0 ? netTotal / saleCount : 0;
  const paymentTotal = payments.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const expenseTotal = Number(expenses?.expense_total ?? 0);
  const grossProfit = Number(summary?.gross_profit ?? 0);
  // Only claimed when both halves are actually visible — see the note at
  // the top of this file.
  const canSeeNetProfit = canSeeMoney && canViewExpenses;
  const netProfit = grossProfit - expenseTotal;
  const urgentStock = lowStock.filter((row) => row.severity !== "low").length;

  /** Keeps the current filters when switching one of them. */
  const linkQuery = (overrides: Record<string, string | undefined>) => {
    const query: Record<string, string> = {};
    if (period.range !== "today") query.range = period.range;
    if (period.range === "custom") {
      if (params.from) query.from = params.from;
      if (params.to) query.to = params.to;
    }
    if (branchId) query.branch = branchId;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete query[key];
      else query[key] = value;
    }
    return query;
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{business?.name ?? "Busihub"}</h1>
          <p className="text-neutral-500">
            {new Date().toLocaleDateString("en-GB", {
              timeZone: period.timezone,
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
            {selectedBranch ? ` · ${selectedBranch.name}` : branches.length > 1 ? " · all branches" : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canViewInventory ? (
            <Link href="/inventory/receive">
              <Button variant="secondary">Receive stock</Button>
            </Link>
          ) : null}
          {canSell ? (
            <Link href="/till">
              <Button>Open the till</Button>
            </Link>
          ) : null}
        </div>
      </div>

      {/* Filters as links, so a particular week at a particular branch is
          a URL that can be bookmarked or sent to someone. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1 rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
          {RANGES.map((option) => (
            <Link
              key={option.value}
              href={{ pathname: "/dashboard", query: linkQuery({ range: option.value, from: undefined, to: undefined }) }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                period.range === option.value
                  ? "bg-brand-600 text-white"
                  : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white"
              }`}
            >
              {option.label}
            </Link>
          ))}
        </div>

        {branches.length > 1 ? (
          <div className="flex flex-wrap gap-1 rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
            <Link
              href={{ pathname: "/dashboard", query: linkQuery({ branch: undefined }) }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                branchId === null
                  ? "bg-brand-600 text-white"
                  : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white"
              }`}
            >
              All branches
            </Link>
            {branches.map((branch) => (
              <Link
                key={branch.id}
                href={{ pathname: "/dashboard", query: linkQuery({ branch: branch.id }) }}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  branchId === branch.id
                    ? "bg-brand-600 text-white"
                    : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white"
                }`}
              >
                {branch.name}
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      {/* Things that need doing, before things that merely happened. A
          sale waiting for payment is holding stock off the shelf, so it
          is the one number worth interrupting someone about. */}
      {waiting > 0 || urgentStock > 0 ? (
        <div className="flex flex-col gap-2">
          {waiting > 0 ? (
            <Link
              href={{ pathname: "/sales", query: { status: "awaiting_payment" } }}
              className="flex items-center justify-between rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950/60"
            >
              <span>
                <span className="font-semibold">{waiting}</span>{" "}
                {waiting === 1 ? "sale is" : "sales are"} still waiting for payment, holding stock off the shelf.
              </span>
              <span aria-hidden="true">→</span>
            </Link>
          ) : null}
          {urgentStock > 0 ? (
            <Link
              href="/inventory"
              className="flex items-center justify-between rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-200 dark:hover:bg-red-950/60"
            >
              <span>
                <span className="font-semibold">{urgentStock}</span>{" "}
                {urgentStock === 1 ? "product has" : "products have"} run out or are about to.
              </span>
              <span aria-hidden="true">→</span>
            </Link>
          ) : null}
        </div>
      ) : null}

      {canSeeMoney ? (
        summaryError ? (
          <Card>
            <p className="text-sm text-neutral-500">
              Today&rsquo;s figures could not be loaded. Reload the page, or check back in a moment.
            </p>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                {
                  label: "Net sales",
                  value: money(summary?.net_total),
                  sub: `${saleCount} ${saleCount === 1 ? "sale" : "sales"} ${period.label}`,
                },
                {
                  label: "Gross profit",
                  value: money(summary?.gross_profit),
                  sub: "before expenses",
                },
                canSeeNetProfit
                  ? {
                      label: "Net profit",
                      value: money(netProfit),
                      sub: `after ${money(expenseTotal)} of expenses`,
                    }
                  : {
                      label: "Average sale",
                      value: money(averageSale),
                      sub: `${Number(summary?.items_sold ?? 0)} items sold`,
                    },
                {
                  label: "Returned",
                  value: money(summary?.refunded_total),
                  sub: Number(summary?.refunded_total ?? 0) > 0 ? "off these takings" : "nothing back",
                },
              ].map((card) => (
                <div
                  key={card.label}
                  className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <p className="text-xs uppercase text-neutral-500">{card.label}</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums">{card.value}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">{card.sub}</p>
                </div>
              ))}
            </div>

            {/* Said plainly rather than buried: sales rung up before cost
                tracking existed carry a cost estimated from today's
                catalog, so their profit is an approximation. */}
            {canSeeNetProfit && netProfit < 0 ? (
              <p className="-mt-3 text-xs text-neutral-500">
                Expenses came to more than the profit on what was sold {period.label}. A month with rent in it often
                looks like this on a quiet day &mdash; the figure to watch is the month, not the day.
              </p>
            ) : null}

            {summary?.any_cost_estimated ? (
              <p className="-mt-3 text-xs text-neutral-500">
                Some sales in this period were rung up before Busihub recorded cost prices. Their profit is estimated
                from the current catalog cost and may be off if a supplier price has changed since.
              </p>
            ) : null}

            <Card>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-semibold">Sales {period.label}</h2>
                <span className="text-sm text-neutral-500">
                  by {period.bucket === "hour" ? "hour" : period.bucket}
                </span>
              </div>
              <div className="mt-4">
                {trendError ? (
                  <p className="py-10 text-center text-sm text-neutral-500">The chart could not be loaded.</p>
                ) : (
                  <SalesChart points={trend} period={period} money={money} showProfit />
                )}
              </div>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <h2 className="font-semibold">How people paid</h2>
                {payments.length > 0 ? (
                  <ul className="mt-4 flex flex-col gap-3">
                    {payments.map((row) => {
                      const amount = Number(row.amount ?? 0);
                      const share = paymentTotal > 0 ? (amount / paymentTotal) * 100 : 0;
                      return (
                        <li key={row.method}>
                          <div className="flex items-baseline justify-between text-sm">
                            <span className="font-medium">{paymentMethodLabel(row.method)}</span>
                            <span className="tabular-nums">
                              {money(amount)}{" "}
                              <span className="text-neutral-500">({share.toFixed(0)}%)</span>
                            </span>
                          </div>
                          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                            <div className="h-full rounded-full bg-brand-500" style={{ width: `${share}%` }} />
                          </div>
                          <p className="mt-1 text-xs text-neutral-500">
                            {Number(row.tender_count ?? 0)}{" "}
                            {Number(row.tender_count ?? 0) === 1 ? "payment" : "payments"}
                            {row.method === "cash" ? " · after change given" : ""}
                            {row.method === "credit" ? " · not yet collected" : ""}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="py-8 text-center text-sm text-neutral-500">
                    Nothing taken {period.label}.
                  </p>
                )}
              </Card>

              <Card>
                <div className="flex items-baseline justify-between">
                  <h2 className="font-semibold">Best sellers</h2>
                  <span className="text-xs text-neutral-500">by profit</span>
                </div>
                {products.length > 0 ? (
                  <ul className="mt-4 divide-y divide-neutral-100 text-sm dark:divide-neutral-800">
                    {products.map((row) => (
                      <li key={row.variant_id} className="flex items-center justify-between gap-3 py-2.5">
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{row.product_name}</span>
                          <span className="text-xs text-neutral-500">
                            {Number(row.quantity_sold ?? 0)} sold · {money(row.revenue)}
                          </span>
                        </span>
                        <span className="whitespace-nowrap font-medium tabular-nums">
                          {money(row.gross_profit)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-8 text-center text-sm text-neutral-500">
                    Nothing sold {period.label} yet.
                  </p>
                )}
              </Card>
            </div>
          </>
        )
      ) : null}

      {canViewExpenses && expenseCategories.length > 0 ? (
        <Card>
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">Where the money went</h2>
            <Link href="/expenses" className="text-sm text-brand-700 hover:underline dark:text-brand-300">
              All expenses
            </Link>
          </div>
          <ul className="mt-4 flex flex-col gap-3">
            {expenseCategories.map((row) => {
              const amount = Number(row.amount ?? 0);
              // Scaled against the biggest line, not against the total:
              // with five categories, shares of the total are all short
              // stubs and the comparison the eye is actually making —
              // "which of these is the big one" — gets harder to see.
              const biggest = Number(expenseCategories[0]?.amount ?? 0);
              const share = biggest > 0 ? (amount / biggest) * 100 : 0;
              return (
                <li key={row.category_id ?? row.category_name}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium">{row.category_name}</span>
                    <span className="tabular-nums">{money(amount)}</span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                    <div className="h-full rounded-full bg-neutral-400 dark:bg-neutral-500" style={{ width: `${share}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
          {Number(expenses?.cash_paid_out ?? 0) > 0 ? (
            <p className="mt-4 text-xs text-neutral-500">
              {money(expenses?.cash_paid_out)} of this came out of the till, so the drawer will be short by that much.
            </p>
          ) : null}
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {canViewInventory ? (
          <Card>
            <div className="flex items-baseline justify-between">
              <h2 className="font-semibold">Running low</h2>
              <Link href="/inventory" className="text-sm text-brand-700 hover:underline dark:text-brand-300">
                Inventory
              </Link>
            </div>
            {lowStock.length > 0 ? (
              <ul className="mt-4 divide-y divide-neutral-100 text-sm dark:divide-neutral-800">
                {lowStock.map((row) => (
                  <li key={`${row.variant_id}-${row.branch_name}`} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{row.product_name}</span>
                      <span className="text-xs text-neutral-500">
                        {row.sku ? `${row.sku} · ` : ""}
                        {row.branch_name} · {Number(row.quantity ?? 0)} left of {Number(row.reorder_point ?? 0)}
                      </span>
                    </span>
                    <span
                      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${
                        SEVERITY_STYLES[row.severity] ?? SEVERITY_STYLES.low
                      }`}
                    >
                      {SEVERITY_LABELS[row.severity] ?? row.severity}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-8 text-center text-sm text-neutral-500">
                Everything is above its reorder point.
              </p>
            )}
          </Card>
        ) : null}

        <Card>
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">Latest sales</h2>
            {canSell || canReport ? (
              <Link href="/sales" className="text-sm text-brand-700 hover:underline dark:text-brand-300">
                See all
              </Link>
            ) : null}
          </div>
          {recentSales.length > 0 ? (
            <ul className="mt-4 divide-y divide-neutral-100 text-sm dark:divide-neutral-800">
              {recentSales.map((sale) => {
                const cashier = [sale.cashier?.first_name, sale.cashier?.last_name].filter(Boolean).join(" ");
                return (
                  <li key={sale.id}>
                    <Link
                      href={`/sales/${sale.id}`}
                      className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                    >
                      <span className="min-w-0">
                        <span className="font-medium">{sale.receipt_number}</span>
                        <span className="block truncate text-xs text-neutral-500">
                          {new Date(sale.created_at).toLocaleTimeString("en-GB", {
                            timeZone: period.timezone,
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          {cashier ? ` · ${cashier}` : ""}
                          {" · "}
                          {paymentMethodLabel(sale.payment_method)}
                          {sale.status !== "completed" ? ` · ${sale.status.replace("_", " ")}` : ""}
                        </span>
                      </span>
                      <span className="whitespace-nowrap font-medium tabular-nums">{money(sale.total)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="py-8 text-center text-sm text-neutral-500">
              Nothing sold yet. {canSell ? "Open the till to ring one up." : ""}
            </p>
          )}
        </Card>
      </div>

      {canSeeMoney && staff.length > 0 ? (
        <Card>
          <h2 className="font-semibold">Who sold what</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <thead className="text-left text-xs uppercase text-neutral-500">
                <tr>
                  <th className="pb-2 font-medium">Cashier</th>
                  <th className="pb-2 text-right font-medium">Sales</th>
                  <th className="pb-2 text-right font-medium">Taken</th>
                  <th className="pb-2 text-right font-medium">Returned</th>
                  <th className="pb-2 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {staff.map((row) => (
                  <tr key={row.cashier_id}>
                    <td className="py-2.5 pr-3">{staffName(row.first_name, row.last_name)}</td>
                    <td className="py-2.5 text-right tabular-nums">{Number(row.sale_count ?? 0)}</td>
                    <td className="py-2.5 text-right tabular-nums">{money(row.gross_total)}</td>
                    <td className="py-2.5 text-right tabular-nums text-neutral-500">
                      {money(row.refunded_total)}
                    </td>
                    <td className="py-2.5 text-right font-medium tabular-nums">{money(row.net_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {canSeeMoney && branchPerf.length > 1 ? (
        <Card>
          <h2 className="font-semibold">Branches</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[24rem] text-sm">
              <thead className="text-left text-xs uppercase text-neutral-500">
                <tr>
                  <th className="pb-2 font-medium">Branch</th>
                  <th className="pb-2 text-right font-medium">Sales</th>
                  <th className="pb-2 text-right font-medium">Net</th>
                  <th className="pb-2 text-right font-medium">Profit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {branchPerf.map((row) => (
                  <tr key={row.branch_id}>
                    <td className="py-2.5 pr-3">
                      <Link
                        href={{ pathname: "/dashboard", query: linkQuery({ branch: row.branch_id }) }}
                        className="hover:underline"
                      >
                        {row.branch_name}
                      </Link>
                      {row.is_main ? <span className="ml-2 text-xs text-neutral-500">main</span> : null}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{Number(row.sale_count ?? 0)}</td>
                    <td className="py-2.5 text-right tabular-nums">{money(row.net_total)}</td>
                    <td className="py-2.5 text-right font-medium tabular-nums">{money(row.gross_profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {canViewCustomers && owed > 0 ? (
        <Link
          href="/customers"
          className="flex items-center justify-between rounded-2xl border border-neutral-200 bg-white px-5 py-4 text-sm hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:bg-neutral-800/50"
        >
          <span>
            <span className="font-semibold tabular-nums">{money(owed)}</span> is owed to you by{" "}
            {Number(snapshot?.owing_customers ?? 0)}{" "}
            {Number(snapshot?.owing_customers ?? 0) === 1 ? "customer" : "customers"}.
          </span>
          <span aria-hidden="true">→</span>
        </Link>
      ) : null}
    </div>
  );
}