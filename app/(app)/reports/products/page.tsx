import { redirect } from "next/navigation";
import { formatReportText } from "@/lib/reports/share";
import { SalesChart, type TrendPoint } from "../../dashboard/sales-chart";
import { ReportShell, StatementLine } from "../report-shell";
import { loadReportContext, exportHref, type ReportSearchParams } from "../load";

export const metadata = { title: "Products report" };

/**
 * The Sales report (../sales/page.tsx) split by product vs. service
 * (migration 0056) — this half covers physical, stocked items only. See
 * that migration's own header for why this needed a real query rewrite
 * rather than an added filter: a checkout can mix a product line and a
 * service line, so a whole sale's total can't be attributed to one type.
 *
 * Deliberately missing "How people paid" and "Who sold what" — those are
 * recorded per whole sale (a tender, a cashier), not per line, so there is
 * no honest way to say how much of a mixed sale's payment or a cashier's
 * shift total was "the product part". Both stay on the combined Sales
 * report, where the question is unambiguous. Agreed with the user before
 * building this rather than guessing at an allocation.
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

export default async function ProductsReportPage({
  searchParams,
}: {
  searchParams: Promise<ReportSearchParams>;
}) {
  const params = await searchParams;
  const context = await loadReportContext(params);

  if (!context.canView) redirect("/dashboard");

  const { money, period } = context;
  const fromIso = period.from.toISOString();
  const toIso = period.to.toISOString();
  const rpcArgs = { p_from: fromIso, p_to: toIso, p_branch_id: context.branchId, p_type: "product" };

  const [{ data: summaryRows, error }, { data: trendRows }, { data: productRows }] = await Promise.all([
    context.supabase.rpc("sales_summary", { ...rpcArgs, p_status: null }),
    context.supabase.rpc("sales_trend", {
      ...rpcArgs,
      p_bucket: period.bucket,
      p_timezone: period.timezone,
    }),
    context.supabase.rpc("top_products", { ...rpcArgs, p_limit: 10 }),
  ]);

  if (error) console.error("ProductsReportPage: sales_summary failed", error);

  const summary = ((summaryRows ?? []) as unknown as SummaryRow[])[0];
  const trend = (trendRows ?? []) as unknown as TrendPoint[];
  const products = (productRows ?? []) as unknown as {
    variant_id: string;
    product_name: string;
    sku: string | null;
    quantity_sold: number | string;
    revenue: number | string;
    gross_profit: number | string;
  }[];

  const saleCount = Number(summary?.sale_count ?? 0);
  const netTotal = Number(summary?.net_total ?? 0);

  const shareText = formatReportText({
    shopName: context.shopName,
    title: "Products report",
    periodLabel: period.label,
    branchLabel: context.branchLabel ?? undefined,
    lines: [
      { label: "Product sales", value: money(summary?.gross_total) },
      { label: "Less returns", value: money(summary?.refunded_total) },
      { label: "Net sales", value: money(summary?.net_total), rule: true },
      { label: "Gross profit", value: money(summary?.gross_profit) },
      {
        label: `${saleCount} ${saleCount === 1 ? "sale" : "sales"}`,
        value: `${Number(summary?.items_sold ?? 0)} items`,
        spaceBefore: true,
      },
      ...(products.length > 0
        ? [
            { label: "Best sellers", value: "", spaceBefore: true },
            ...products.slice(0, 5).map((row) => ({
              label: row.product_name,
              value: money(row.revenue),
            })),
          ]
        : []),
    ],
  });

  return (
    <ReportShell
      title="Products report"
      description="Revenue, profit and best sellers for physical products only — services are excluded."
      shopName={context.shopName}
      period={period}
      branchId={context.branchId}
      branches={context.branches}
      pathname="/reports/products"
      shareText={shareText}
      csvHref={context.canExport ? exportHref("products", context) : undefined}
    >
      {error ? (
        <p className="py-10 text-center text-neutral-500 dark:text-ink-muted">
          This report couldn&rsquo;t be loaded. Reload the page, or try again in a moment.
        </p>
      ) : (
        <>
          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card print:rounded-none print:border-0 print:p-0">
            <StatementLine
              label="Product sales"
              value={money(summary?.gross_total)}
              note={`${saleCount} ${saleCount === 1 ? "sale" : "sales"} · ${Number(
                summary?.items_sold ?? 0
              )} items`}
            />
            <StatementLine label="Less returns" value={money(summary?.refunded_total)} />
            <StatementLine label="Net sales" value={money(summary?.net_total)} rule emphasis />
            <StatementLine
              label="Gross profit"
              value={money(summary?.gross_profit)}
              note="before expenses"
            />
            {saleCount > 0 ? (
              <p className="mt-3 text-sm text-neutral-500 dark:text-ink-muted">
                An average of {money(netTotal / saleCount)} a sale.
              </p>
            ) : null}
            <p className="mt-3 text-sm text-neutral-500 dark:text-ink-muted">
              A sale that also included a service is counted here and on the Services report — each report
              only totals its own kind of line, not the whole cart.
            </p>
          </section>

          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card print:rounded-none print:border-0 print:p-0">
            <h2 className="font-semibold">Products {period.label}</h2>
            <div className="mt-4">
              <SalesChart points={trend} period={period} money={money} showProfit />
            </div>
          </section>

          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card print:rounded-none print:border-0 print:p-0">
            <h2 className="font-semibold">Best sellers</h2>
            {products.length > 0 ? (
              <div className="mt-3">
                {products.map((row) => (
                  <StatementLine
                    key={row.variant_id}
                    label={row.product_name}
                    value={money(row.revenue)}
                    note={`${Number(row.quantity_sold ?? 0)} sold · ${money(row.gross_profit)} profit`}
                  />
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-neutral-500 dark:text-ink-muted">
                Nothing sold {period.label}.
              </p>
            )}
          </section>

          {summary?.any_cost_estimated ? (
            <p className="text-sm text-neutral-500 dark:text-ink-muted print:text-xs">
              Some sales in this period were rung up before Busihub recorded cost prices. Their gross profit is
              estimated from the current catalogue.
            </p>
          ) : null}
        </>
      )}
    </ReportShell>
  );
}