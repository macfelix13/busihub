import { redirect } from "next/navigation";
import { formatReportText } from "@/lib/reports/share";
import { ReportShell } from "../report-shell";
import { loadReportContext, exportHref, type ReportSearchParams } from "../load";

export const metadata = { title: "What your stock is worth" };

const PAGE_LIMIT = 200;

interface StockRow {
  variant_id: string;
  product_name: string;
  sku: string | null;
  branch_id: string;
  branch_name: string;
  quantity: number | string;
  cost_price: number | string;
  selling_price: number | string;
  cost_value: number | string;
  retail_value: number | string;
}

interface TotalsRow {
  variant_count: number | string;
  unit_count: number | string;
  cost_value: number | string;
  retail_value: number | string;
  negative_lines: number | string;
}

export default async function StockReportPage({
  searchParams,
}: {
  searchParams: Promise<ReportSearchParams>;
}) {
  const params = await searchParams;
  const context = await loadReportContext(params);

  if (!context.canView) redirect("/dashboard");

  const { money, period } = context;

  const [{ data: rows, error }, { data: totalsRows }] = await Promise.all([
    context.supabase.rpc("stock_valuation", { p_branch_id: context.branchId, p_limit: PAGE_LIMIT }),
    context.supabase.rpc("stock_valuation_totals", { p_branch_id: context.branchId }),
  ]);

  if (error) console.error("StockReportPage: stock_valuation failed", error);

  const lines = (rows ?? []) as unknown as StockRow[];
  const totals = ((totalsRows ?? []) as unknown as TotalsRow[])[0];

  const costValue = Number(totals?.cost_value ?? 0);
  const retailValue = Number(totals?.retail_value ?? 0);
  const potentialProfit = retailValue - costValue;
  const negativeLines = Number(totals?.negative_lines ?? 0);
  const shown = lines.length;
  const counted = Number(totals?.variant_count ?? 0);

  const shareText = formatReportText({
    shopName: context.shopName,
    title: "What your stock is worth",
    periodLabel: `as at ${new Date().toLocaleDateString("en-GB", {
      timeZone: period.timezone,
      day: "numeric",
      month: "long",
      year: "numeric",
    })}`,
    branchLabel: context.branchLabel ?? undefined,
    lines: [
      { label: "At cost", value: money(costValue) },
      { label: "At selling price", value: money(retailValue) },
      { label: "Profit if it all sells", value: money(potentialProfit), rule: true },
      { label: `${counted} lines`, value: `${Number(totals?.unit_count ?? 0)} units`, spaceBefore: true },
      { label: "Biggest holdings", value: "", spaceBefore: true },
      ...lines.slice(0, 10).map((row) => ({
        label: row.product_name,
        value: money(row.cost_value),
      })),
    ],
    footnotes: [
      "Valued at today's cost and today's selling price.",
      negativeLines > 0
        ? `${negativeLines} ${negativeLines === 1 ? "line shows" : "lines show"} negative stock — count those before trusting this total.`
        : "",
    ].filter(Boolean),
  });

  return (
    <ReportShell
      title="What your stock is worth"
      description="Money sitting on the shelves, biggest holding first."
      shopName={context.shopName}
      period={period}
      branchId={context.branchId}
      branches={context.branches}
      pathname="/reports/stock"
      shareText={shareText}
      csvHref={context.canExport ? exportHref("stock", context) : undefined}
      showPeriod={false}
    >
      {error ? (
        <p className="py-10 text-center text-neutral-500 dark:text-ink-muted">
          This report couldn&rsquo;t be loaded. Reload the page, or try again in a moment.
        </p>
      ) : counted === 0 ? (
        <p className="py-12 text-center text-neutral-500 dark:text-ink-muted">
          Nothing on the shelves yet. Receive some stock and it will be valued here.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 print:grid-cols-4">
            {[
              { label: "At cost", value: money(costValue), sub: "what you paid" },
              { label: "At selling price", value: money(retailValue), sub: "if it all sells" },
              {
                label: "Profit in the stock",
                value: money(potentialProfit),
                sub: retailValue > 0 ? `${((potentialProfit / retailValue) * 100).toFixed(0)}% margin` : "",
              },
              {
                label: "On the shelves",
                value: String(Number(totals?.unit_count ?? 0)),
                sub: `${counted} ${counted === 1 ? "line" : "lines"}`,
              },
            ].map((card) => (
              <div
                key={card.label}
                className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-surface-line dark:bg-surface-card print:rounded-none print:border print:p-2"
              >
                <p className="text-xs uppercase text-neutral-500 dark:text-ink-muted">{card.label}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{card.value}</p>
                <p className="mt-0.5 text-xs text-neutral-500 dark:text-ink-muted">{card.sub}</p>
              </div>
            ))}
          </div>

          {/* Surfaced, not hidden: stock below zero means the ledger and
              the shelf disagree, and every figure above is wrong until
              someone counts. */}
          {negativeLines > 0 ? (
            <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <span className="font-semibold">{negativeLines}</span>{" "}
              {negativeLines === 1 ? "line shows" : "lines show"} negative stock, which means the ledger and the shelf
              disagree. Count those items before relying on this valuation.
            </p>
          ) : null}

          <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white dark:border-surface-line dark:bg-surface-card print:rounded-none print:border-0">
            <table className="w-full min-w-[42rem] text-sm">
              <thead className="text-left text-xs uppercase text-neutral-500 dark:text-ink-muted">
                <tr className="border-b border-neutral-100 dark:border-surface-line">
                  <th className="px-4 py-3 font-medium">Product</th>
                  {context.branchId === null && context.branches.length > 1 ? (
                    <th className="px-4 py-3 font-medium">Branch</th>
                  ) : null}
                  <th className="px-4 py-3 text-right font-medium">Qty</th>
                  <th className="px-4 py-3 text-right font-medium">Cost each</th>
                  <th className="px-4 py-3 text-right font-medium">At cost</th>
                  <th className="px-4 py-3 text-right font-medium">At retail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-surface-line">
                {lines.map((row) => (
                  <tr key={`${row.variant_id}-${row.branch_id}`}>
                    <td className="px-4 py-3">
                      <span className="font-medium">{row.product_name}</span>
                      {row.sku ? (
                        <span className="block text-xs text-neutral-500 dark:text-ink-muted">{row.sku}</span>
                      ) : null}
                    </td>
                    {context.branchId === null && context.branches.length > 1 ? (
                      <td className="px-4 py-3 text-neutral-500 dark:text-ink-muted">{row.branch_name}</td>
                    ) : null}
                    <td
                      className={`px-4 py-3 text-right tabular-nums ${
                        Number(row.quantity) < 0 ? "font-medium text-red-600 dark:text-red-400" : ""
                      }`}
                    >
                      {Number(row.quantity)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-neutral-500 dark:text-ink-muted">
                      {money(row.cost_price)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">{money(row.cost_value)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-neutral-500 dark:text-ink-muted">
                      {money(row.retail_value)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-neutral-300 font-semibold dark:border-surface-line">
                  <td className="px-4 py-3" colSpan={context.branchId === null && context.branches.length > 1 ? 4 : 3}>
                    {/* Said plainly when the table is a subset: the total
                        below is every line, not the ones on screen. */}
                    {shown < counted ? `Total (all ${counted} lines, ${shown} shown)` : "Total"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(costValue)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(retailValue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="text-sm text-neutral-500 dark:text-ink-muted print:text-xs">
            Valued at today&rsquo;s cost and today&rsquo;s selling price. This is not a forecast: it is what the stock
            would come to if every unit sold at the current price, which nothing ever does.
          </p>
        </>
      )}
    </ReportShell>
  );
}