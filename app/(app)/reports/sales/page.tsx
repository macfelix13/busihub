import { redirect } from "next/navigation";
import { formatReportText } from "@/lib/reports/share";
import { paymentMethodLabel } from "@/lib/validation/sales";
import { SalesChart, type TrendPoint } from "../../dashboard/sales-chart";
import { ReportShell, StatementLine } from "../report-shell";
import { loadReportContext, exportHref, type ReportSearchParams } from "../load";

export const metadata = { title: "Sales report" };

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

export default async function SalesReportPage({
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
  const rpcArgs = { p_from: fromIso, p_to: toIso, p_branch_id: context.branchId };

  const [
    { data: summaryRows, error },
    { data: trendRows },
    { data: paymentRows },
    { data: productRows },
    { data: staffRows },
    { data: providerRows },
  ] = await Promise.all([
    context.supabase.rpc("sales_summary", { ...rpcArgs, p_status: null }),
    context.supabase.rpc("sales_trend", {
      ...rpcArgs,
      p_bucket: period.bucket,
      p_timezone: period.timezone,
    }),
    context.supabase.rpc("payment_method_breakdown", rpcArgs),
    context.supabase.rpc("top_products", { ...rpcArgs, p_limit: 10 }),
    context.supabase.rpc("staff_performance", { ...rpcArgs, p_limit: 20 }),
    // Revenue by whoever actually RENDERED a service line (migration
    // 0041) — a different question from "Who sold what" above, which
    // attributes a whole sale to its cashier. See that function's own
    // comment for why it isn't derived from staff_performance().
    context.supabase.rpc("service_provider_performance", { ...rpcArgs, p_limit: 20 }),
  ]);

  if (error) console.error("SalesReportPage: sales_summary failed", error);

  const summary = ((summaryRows ?? []) as unknown as SummaryRow[])[0];
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
  const staff = (staffRows ?? []) as unknown as {
    cashier_id: string;
    first_name: string | null;
    last_name: string | null;
    sale_count: number | string;
    gross_total: number | string;
    refunded_total: number | string;
    net_total: number | string;
  }[];
  const providers = (providerRows ?? []) as unknown as {
    provider_id: string;
    first_name: string | null;
    last_name: string | null;
    service_count: number | string;
    gross_total: number | string;
    refunded_total: number | string;
    net_total: number | string;
  }[];

  const saleCount = Number(summary?.sale_count ?? 0);
  const netTotal = Number(summary?.net_total ?? 0);
  const paymentTotal = payments.reduce((total, row) => total + Number(row.amount ?? 0), 0);

  const shareText = formatReportText({
    shopName: context.shopName,
    title: "Sales report",
    periodLabel: period.label,
    branchLabel: context.branchLabel ?? undefined,
    lines: [
      { label: "Sales", value: money(summary?.gross_total) },
      { label: "Less returns", value: money(summary?.refunded_total) },
      { label: "Net sales", value: money(summary?.net_total), rule: true },
      { label: "Gross profit", value: money(summary?.gross_profit) },
      {
        label: `${saleCount} ${saleCount === 1 ? "sale" : "sales"}`,
        value: `${Number(summary?.items_sold ?? 0)} items`,
        spaceBefore: true,
      },
      { label: "How people paid", value: "", spaceBefore: true },
      ...payments.map((row) => ({
        label: paymentMethodLabel(row.method),
        value: money(row.amount),
      })),
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
      title="Sales report"
      description="What sold, how it was paid for, and who sold it."
      shopName={context.shopName}
      period={period}
      branchId={context.branchId}
      branches={context.branches}
      pathname="/reports/sales"
      shareText={shareText}
      csvHref={context.canExport ? exportHref("sales", context) : undefined}
    >
      {error ? (
        <p className="py-10 text-center text-neutral-500">
          This report couldn&rsquo;t be loaded. Reload the page, or try again in a moment.
        </p>
      ) : (
        <>
          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900 print:rounded-none print:border-0 print:p-0">
            <StatementLine
              label="Sales"
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
              <p className="mt-3 text-sm text-neutral-500">
                An average of {money(netTotal / saleCount)} a sale.
              </p>
            ) : null}
          </section>

          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900 print:rounded-none print:border-0 print:p-0">
            <h2 className="font-semibold">Sales {period.label}</h2>
            <div className="mt-4">
              <SalesChart points={trend} period={period} money={money} showProfit />
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2 print:grid-cols-2">
            <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900 print:rounded-none print:border-0 print:p-0">
              <h2 className="font-semibold">How people paid</h2>
              {payments.length > 0 ? (
                <div className="mt-3">
                  {payments.map((row) => (
                    <StatementLine
                      key={row.method}
                      label={paymentMethodLabel(row.method)}
                      value={money(row.amount)}
                      note={
                        paymentTotal > 0
                          ? `${((Number(row.amount ?? 0) / paymentTotal) * 100).toFixed(0)}%`
                          : undefined
                      }
                    />
                  ))}
                  <StatementLine label="Total taken" value={money(paymentTotal)} rule emphasis />
                </div>
              ) : (
                <p className="py-8 text-center text-sm text-neutral-500">Nothing taken {period.label}.</p>
              )}
            </section>

            <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900 print:rounded-none print:border-0 print:p-0">
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
                <p className="py-8 text-center text-sm text-neutral-500">Nothing sold {period.label}.</p>
              )}
            </section>
          </div>

          {staff.length > 0 ? (
            <section className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900 print:rounded-none print:border-0 print:p-0">
              <h2 className="font-semibold">Who sold what</h2>
              <table className="mt-4 w-full min-w-[28rem] text-sm">
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
                      <td className="py-2.5 pr-3">
                        {[row.first_name, row.last_name].filter(Boolean).join(" ") || "Unnamed user"}
                      </td>
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
            </section>
          ) : null}

          {providers.length > 0 ? (
            <section className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900 print:rounded-none print:border-0 print:p-0">
              <h2 className="font-semibold">Who rendered what</h2>
              <p className="mt-1 text-sm text-neutral-500">
                Service revenue by whoever actually did the work, not whoever rang up the sale — one checkout can
                cover more than one person&rsquo;s work.
              </p>
              <table className="mt-4 w-full min-w-[28rem] text-sm">
                <thead className="text-left text-xs uppercase text-neutral-500">
                  <tr>
                    <th className="pb-2 font-medium">Staff</th>
                    <th className="pb-2 text-right font-medium">Services</th>
                    <th className="pb-2 text-right font-medium">Taken</th>
                    <th className="pb-2 text-right font-medium">Returned</th>
                    <th className="pb-2 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {providers.map((row) => (
                    <tr key={row.provider_id}>
                      <td className="py-2.5 pr-3">
                        {[row.first_name, row.last_name].filter(Boolean).join(" ") || "Unnamed user"}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{Number(row.service_count ?? 0)}</td>
                      <td className="py-2.5 text-right tabular-nums">{money(row.gross_total)}</td>
                      <td className="py-2.5 text-right tabular-nums text-neutral-500">
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
            <p className="text-sm text-neutral-500 print:text-xs">
              Some sales in this period were rung up before Busihub recorded cost prices. Their gross profit is
              estimated from the current catalogue.
            </p>
          ) : null}
        </>
      )}
    </ReportShell>
  );
}