import { redirect } from "next/navigation";
import { formatReportText } from "@/lib/reports/share";
import { ReportShell, StatementLine } from "../report-shell";
import { loadReportContext, exportHref, type ReportSearchParams } from "../load";

export const metadata = { title: "Profit and loss" };

interface PlRow {
  gross_sales: number | string;
  refunds: number | string;
  net_sales: number | string;
  cost_of_goods: number | string;
  gross_profit: number | string;
  expense_total: number | string;
  net_profit: number | string;
  sale_count: number | string;
  items_sold: number | string;
  expense_count: number | string;
  cash_expenses: number | string;
  any_cost_estimated: boolean;
}

export default async function ProfitLossPage({
  searchParams,
}: {
  searchParams: Promise<ReportSearchParams>;
}) {
  const params = await searchParams;
  const context = await loadReportContext(params);

  if (!context.canView) redirect("/dashboard");

  const { money, period } = context;

  const [{ data: plRows, error }, { data: categoryRows }] = await Promise.all([
    context.supabase.rpc("profit_and_loss", {
      p_from: context.fromDate,
      p_to: context.toDate,
      p_branch_id: context.branchId,
      p_timezone: period.timezone,
    }),
    context.supabase.rpc("expenses_by_category", {
      p_from: context.fromDate,
      p_to: context.toDate,
      p_branch_id: context.branchId,
      p_limit: 20,
    }),
  ]);

  // Logged, never rendered: a database error names columns and functions
  // and none of that belongs on a page someone shows their bank.
  if (error) console.error("ProfitLossPage: profit_and_loss failed", error);

  const pl = ((plRows ?? []) as unknown as PlRow[])[0];
  const categories = (categoryRows ?? []) as unknown as {
    category_id: string | null;
    category_name: string;
    amount: number | string;
    expense_count: number | string;
  }[];

  const netProfit = Number(pl?.net_profit ?? 0);
  const netSales = Number(pl?.net_sales ?? 0);
  // Margin on net sales, not on gross: what came back was never earned.
  const margin = netSales > 0 ? (netProfit / netSales) * 100 : null;

  const shareText = formatReportText({
    shopName: context.shopName,
    title: "Profit and loss",
    periodLabel: period.label,
    branchLabel: context.branchLabel ?? undefined,
    lines: [
      { label: "Sales", value: money(pl?.gross_sales) },
      { label: "Less returns", value: money(pl?.refunds) },
      { label: "Net sales", value: money(pl?.net_sales), rule: true },
      { label: "Cost of goods sold", value: money(pl?.cost_of_goods), spaceBefore: true },
      { label: "Gross profit", value: money(pl?.gross_profit), rule: true },
      { label: "Expenses", value: money(pl?.expense_total), spaceBefore: true },
      ...categories.map((c) => ({ label: `  ${c.category_name}`, value: money(c.amount) })),
      { label: "NET PROFIT", value: money(pl?.net_profit), rule: true },
    ],
    footnotes: [
      margin !== null ? `Margin: ${margin.toFixed(1)}% of net sales.` : "",
      pl?.any_cost_estimated
        ? "Some costs are estimated from the current catalogue for sales rung up before cost tracking."
        : "",
    ].filter(Boolean),
  });

  return (
    <ReportShell
      title="Profit and loss"
      description="What came in, what the goods cost, what went out, and what is left."
      shopName={context.shopName}
      period={period}
      branchId={context.branchId}
      branches={context.branches}
      pathname="/reports/profit-loss"
      shareText={shareText}
      csvHref={context.canExport ? exportHref("profit-loss", context) : undefined}
    >
      {error ? (
        <p className="py-10 text-center text-neutral-500 dark:text-ink-muted">
          This report couldn&rsquo;t be loaded. Reload the page, or try again in a moment.
        </p>
      ) : (
        <>
          <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card print:rounded-none print:border-0 print:p-0">
            <StatementLine
              label="Sales"
              value={money(pl?.gross_sales)}
              note={`${Number(pl?.sale_count ?? 0)} sales · ${Number(pl?.items_sold ?? 0)} items`}
            />
            <StatementLine label="Less returns" value={money(pl?.refunds)} />
            <StatementLine label="Net sales" value={money(pl?.net_sales)} rule emphasis />

            <StatementLine
              label="Cost of goods sold"
              value={money(pl?.cost_of_goods)}
              note="what the goods cost when they were sold"
            />
            <StatementLine label="Gross profit" value={money(pl?.gross_profit)} rule emphasis />

            <StatementLine
              label="Expenses"
              value={money(pl?.expense_total)}
              note={`${Number(pl?.expense_count ?? 0)} recorded`}
            />
            <StatementLine
              label="Net profit"
              value={money(pl?.net_profit)}
              rule
              emphasis
              negative={netProfit < 0}
            />

            {margin !== null ? (
              <p className="mt-3 text-sm text-neutral-500 dark:text-ink-muted">
                A margin of {margin.toFixed(1)}% — you keep {money(netProfit / (netSales / 100))} of every{" "}
                {money(100)} you take.
              </p>
            ) : null}
          </section>

          {categories.length > 0 ? (
            <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card print:rounded-none print:border-0 print:p-0">
              <h2 className="font-semibold">Expenses in detail</h2>
              <div className="mt-3">
                {categories.map((row) => (
                  <StatementLine
                    key={row.category_id ?? row.category_name}
                    label={row.category_name}
                    value={money(row.amount)}
                    note={`${Number(row.expense_count ?? 0)} ${
                      Number(row.expense_count ?? 0) === 1 ? "entry" : "entries"
                    }`}
                  />
                ))}
                <StatementLine label="Total expenses" value={money(pl?.expense_total)} rule emphasis />
              </div>
              {Number(pl?.cash_expenses ?? 0) > 0 ? (
                <p className="mt-3 text-sm text-neutral-500 dark:text-ink-muted">
                  {money(pl?.cash_expenses)} of this was paid out of the till.
                </p>
              ) : null}
            </section>
          ) : null}

          {/* Said in words rather than buried: a statement someone takes
              to a bank should say which of its figures are estimates. */}
          {pl?.any_cost_estimated ? (
            <p className="text-sm text-neutral-500 dark:text-ink-muted">
              Some sales in this period were rung up before Busihub recorded cost prices. Their cost is estimated from
              the current catalogue, so gross profit is approximate for those lines.
            </p>
          ) : null}

          <p className="text-sm text-neutral-500 dark:text-ink-muted print:text-xs">
            Net profit is gross profit less recorded expenses. It does not include depreciation, tax, or anything not
            entered as an expense in Busihub.
          </p>
        </>
      )}
    </ReportShell>
  );
}