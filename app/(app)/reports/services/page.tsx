import { redirect } from "next/navigation";
import { formatReportText } from "@/lib/reports/share";
import { SalesChart, type TrendPoint } from "../../dashboard/sales-chart";
import { ReportShell, StatementLine } from "../report-shell";
import { loadReportContext, exportHref, type ReportSearchParams } from "../load";

export const metadata = { title: "Services report" };

/**
 * The Sales report (../sales/page.tsx) split by product vs. service
 * (migration 0056) — this half covers labour/service items only. See that
 * migration's own header for why this needed a real query rewrite rather
 * than an added filter: a checkout can mix a product line and a service
 * line, so a whole sale's total can't be attributed to one type.
 *
 * Deliberately missing "How people paid" and "Who sold what" (the
 * cashier) — those are recorded per whole sale, not per line, so there is
 * no honest way to split them by type. They stay on the combined Sales
 * report. "Who rendered what" below is different and IS included: it was
 * already line-level before this migration touched anything
 * (service_provider_performance(), 0041/0045), so there is no ambiguity
 * to resolve — it is reused here exactly as it already existed.
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

export default async function ServicesReportPage({
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
  const rpcArgs = { p_from: fromIso, p_to: toIso, p_branch_id: context.branchId, p_type: "service" };

  const [
    { data: summaryRows, error },
    { data: trendRows },
    { data: serviceRows },
    { data: providerRows },
  ] = await Promise.all([
    context.supabase.rpc("sales_summary", { ...rpcArgs, p_status: null }),
    context.supabase.rpc("sales_trend", {
      ...rpcArgs,
      p_bucket: period.bucket,
      p_timezone: period.timezone,
    }),
    context.supabase.rpc("top_products", { ...rpcArgs, p_limit: 10 }),
    // Already line-level, unaffected by 0056 — "who actually did the
    // work", not "who was cashiering" — see sales/page.tsx's own comment
    // on why it isn't derived from staff_performance().
    context.supabase.rpc("service_provider_performance", {
      p_from: fromIso,
      p_to: toIso,
      p_branch_id: context.branchId,
      p_limit: 20,
    }),
  ]);

  if (error) console.error("ServicesReportPage: sales_summary failed", error);

  const summary = ((summaryRows ?? []) as unknown as SummaryRow[])[0];
  const trend = (trendRows ?? []) as unknown as TrendPoint[];
  const services = (serviceRows ?? []) as unknown as {
    variant_id: string;
    product_name: string;
    sku: string | null;
    quantity_sold: number | string;
    revenue: number | string;
    gross_profit: number | string;
  }[];
  const providers = (providerRows ?? []) as unknown as {
    renderer_type: "staff" | "provider";
    renderer_id: string;
    full_name: string | null;
    title: string | null;
    service_count: number | string;
    gross_total: number | string;
    refunded_total: number | string;
    net_total: number | string;
  }[];

  const saleCount = Number(summary?.sale_count ?? 0);
  const netTotal = Number(summary?.net_total ?? 0);

  const shareText = formatReportText({
    shopName: context.shopName,
    title: "Services report",
    periodLabel: period.label,
    branchLabel: context.branchLabel ?? undefined,
    lines: [
      { label: "Service sales", value: money(summary?.gross_total) },
      { label: "Less returns", value: money(summary?.refunded_total) },
      { label: "Net sales", value: money(summary?.net_total), rule: true },
      { label: "Gross profit", value: money(summary?.gross_profit) },
      {
        label: `${saleCount} ${saleCount === 1 ? "sale" : "sales"}`,
        value: `${Number(summary?.items_sold ?? 0)} services`,
        spaceBefore: true,
      },
      ...(services.length > 0
        ? [
            { label: "Top services", value: "", spaceBefore: true },
            ...services.slice(0, 5).map((row) => ({
              label: row.product_name,
              value: money(row.revenue),
            })),
          ]
        : []),
    ],
  });

  return (
    <ReportShell
      title="Services report"
      description="Revenue, profit, top services and who rendered them — physical products are excluded."
      shopName={context.shopName}
      period={period}
      branchId={context.branchId}
      branches={context.branches}
      pathname="/reports/services"
      shareText={shareText}
      csvHref={context.canExport ? exportHref("services", context) : undefined}
    >
      {error ? (
        <p className="py-10 text-center text-neutral-500 dark:text-ink-muted">
          This report couldn&rsquo;t be loaded. Reload the page, or try again in a moment.
        </p>
      ) : (
        <>
          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card print:rounded-none print:border-0 print:p-0">
            <StatementLine
              label="Service sales"
              value={money(summary?.gross_total)}
              note={`${saleCount} ${saleCount === 1 ? "sale" : "sales"} · ${Number(
                summary?.items_sold ?? 0
              )} services`}
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
              A sale that also included a product is counted here and on the Products report — each report
              only totals its own kind of line, not the whole cart.
            </p>
          </section>

          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card print:rounded-none print:border-0 print:p-0">
            <h2 className="font-semibold">Services {period.label}</h2>
            <div className="mt-4">
              <SalesChart points={trend} period={period} money={money} showProfit />
            </div>
          </section>

          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card print:rounded-none print:border-0 print:p-0">
            <h2 className="font-semibold">Top services</h2>
            {services.length > 0 ? (
              <div className="mt-3">
                {services.map((row) => (
                  <StatementLine
                    key={row.variant_id}
                    label={row.product_name}
                    value={money(row.revenue)}
                    note={`${Number(row.quantity_sold ?? 0)} rendered · ${money(row.gross_profit)} profit`}
                  />
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-neutral-500 dark:text-ink-muted">
                Nothing sold {period.label}.
              </p>
            )}
          </section>

          {providers.length > 0 ? (
            <section className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card print:rounded-none print:border-0 print:p-0">
              <h2 className="font-semibold">Who rendered what</h2>
              <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
                Service revenue by whoever actually did the work, not whoever rang up the sale.
              </p>
              <table className="mt-4 w-full min-w-[28rem] text-sm">
                <thead className="text-left text-xs uppercase text-neutral-500 dark:text-ink-muted">
                  <tr>
                    <th className="pb-2 font-medium">Staff</th>
                    <th className="pb-2 text-right font-medium">Services</th>
                    <th className="pb-2 text-right font-medium">Taken</th>
                    <th className="pb-2 text-right font-medium">Returned</th>
                    <th className="pb-2 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-surface-line">
                  {providers.map((row) => (
                    <tr key={`${row.renderer_type}:${row.renderer_id}`}>
                      <td className="py-2.5 pr-3">
                        {row.full_name || "Unnamed"}
                        {row.title ? (
                          <span className="ml-1 text-neutral-500 dark:text-ink-muted">· {row.title}</span>
                        ) : null}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{Number(row.service_count ?? 0)}</td>
                      <td className="py-2.5 text-right tabular-nums">{money(row.gross_total)}</td>
                      <td className="py-2.5 text-right tabular-nums text-neutral-500 dark:text-ink-muted">
                        {money(row.refunded_total)}
                      </td>
                      <td className="py-2.5 text-right font-medium tabular-nums">{money(row.net_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

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