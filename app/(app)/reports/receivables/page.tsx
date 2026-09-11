import Link from "next/link";
import { redirect } from "next/navigation";
import { formatReportText } from "@/lib/reports/share";
import { ReportShell } from "../report-shell";
import { loadReportContext, exportHref, type ReportSearchParams } from "../load";

export const metadata = { title: "Who owes you" };

interface AgingRow {
  customer_id: string;
  customer_name: string;
  phone: string | null;
  total_owed: number | string;
  current_amount: number | string;
  days_30: number | string;
  days_60: number | string;
  days_90_plus: number | string;
  oldest_unpaid: string | null;
  credit_limit: number | string;
}

export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<ReportSearchParams>;
}) {
  const params = await searchParams;
  const context = await loadReportContext(params);

  if (!context.canView) redirect("/dashboard");

  const { money, period } = context;

  const { data: rows, error } = await context.supabase.rpc("receivables_aging", {
    p_as_of: null,
    p_timezone: period.timezone,
  });

  if (error) console.error("ReceivablesPage: receivables_aging failed", error);

  const debtors = (rows ?? []) as unknown as AgingRow[];

  const sum = (key: keyof AgingRow) =>
    debtors.reduce((total, row) => total + Number(row[key] ?? 0), 0);

  const total = sum("total_owed");
  const overdue = sum("days_30") + sum("days_60") + sum("days_90_plus");
  const oldest = sum("days_90_plus");

  const shareText = formatReportText({
    shopName: context.shopName,
    title: "Who owes you",
    periodLabel: `as at ${new Date().toLocaleDateString("en-GB", {
      timeZone: period.timezone,
      day: "numeric",
      month: "long",
      year: "numeric",
    })}`,
    lines: [
      { label: "Owed to you", value: money(total) },
      { label: "Of that, overdue", value: money(overdue) },
      { label: "Over 90 days", value: money(oldest) },
      { label: `${debtors.length} on account`, value: "", spaceBefore: true },
      ...debtors.slice(0, 15).map((row) => ({
        label: row.customer_name,
        value: money(row.total_owed),
      })),
      ...(debtors.length > 15
        ? [{ label: `…and ${debtors.length - 15} more`, value: "", spaceBefore: true }]
        : []),
    ],
  });

  const columns: { key: keyof AgingRow; label: string }[] = [
    { key: "current_amount", label: "Current" },
    { key: "days_30", label: "30 days" },
    { key: "days_60", label: "60 days" },
    { key: "days_90_plus", label: "90+ days" },
  ];

  return (
    <ReportShell
      title="Who owes you"
      description="Every customer on account, oldest debt first."
      shopName={context.shopName}
      period={period}
      branchId={null}
      branches={[]}
      pathname="/reports/receivables"
      shareText={shareText}
      csvHref={context.canExport ? exportHref("receivables", context) : undefined}
      showPeriod={false}
    >
      {error ? (
        <p className="py-10 text-center text-neutral-500 dark:text-ink-muted">
          This report couldn&rsquo;t be loaded. Reload the page, or try again in a moment.
        </p>
      ) : debtors.length === 0 ? (
        <p className="py-12 text-center text-neutral-500 dark:text-ink-muted">
          Nobody owes you anything. Every account is settled.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 print:grid-cols-4">
            {[
              { label: "Owed to you", value: money(total), sub: `${debtors.length} customers` },
              {
                label: "Overdue",
                value: money(overdue),
                sub: total > 0 ? `${((overdue / total) * 100).toFixed(0)}% of the total` : "",
              },
              { label: "Over 90 days", value: money(oldest), sub: "chase these first" },
              {
                label: "Current",
                value: money(sum("current_amount")),
                sub: "not due yet",
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

          <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white dark:border-surface-line dark:bg-surface-card print:rounded-none print:border-0">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="text-left text-xs uppercase text-neutral-500 dark:text-ink-muted">
                <tr className="border-b border-neutral-100 dark:border-surface-line">
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 text-right font-medium">Owed</th>
                  {columns.map((column) => (
                    <th key={column.key} className="px-4 py-3 text-right font-medium">
                      {column.label}
                    </th>
                  ))}
                  <th className="px-4 py-3 text-right font-medium">Oldest</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-surface-line">
                {debtors.map((row) => {
                  const overLimit =
                    Number(row.credit_limit ?? 0) > 0 &&
                    Number(row.total_owed ?? 0) > Number(row.credit_limit ?? 0);
                  return (
                    <tr key={row.customer_id}>
                      <td className="px-4 py-3">
                        <Link
                          href={`/customers/${row.customer_id}`}
                          className="font-medium hover:underline print:no-underline"
                        >
                          {row.customer_name}
                        </Link>
                        <span className="block text-xs text-neutral-500 dark:text-ink-muted">
                          {row.phone ?? "no phone number"}
                          {overLimit ? " · over their credit limit" : ""}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">
                        {money(row.total_owed)}
                      </td>
                      {columns.map((column) => {
                        const value = Number(row[column.key] ?? 0);
                        return (
                          <td
                            key={column.key}
                            className={`px-4 py-3 text-right tabular-nums ${
                              value === 0 ? "text-neutral-300 dark:text-ink-muted" : ""
                            } ${
                              column.key === "days_90_plus" && value > 0
                                ? "font-medium text-red-600 dark:text-red-400"
                                : ""
                            }`}
                          >
                            {value === 0 ? "—" : money(value)}
                          </td>
                        );
                      })}
                      <td className="px-4 py-3 text-right text-xs text-neutral-500 dark:text-ink-muted">
                        {row.oldest_unpaid
                          ? new Date(`${row.oldest_unpaid}T00:00:00`).toLocaleDateString("en-GB", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-neutral-300 font-semibold dark:border-surface-line">
                  <td className="px-4 py-3">Total</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(total)}</td>
                  {columns.map((column) => (
                    <td key={column.key} className="px-4 py-3 text-right tabular-nums">
                      {money(sum(column.key))}
                    </td>
                  ))}
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {/* The assumption is stated on the report, not just in the
              migration. Someone reading a 90-day column is entitled to
              know how a payment was applied to produce it. */}
          <p className="text-sm text-neutral-500 dark:text-ink-muted print:text-xs">
            Ages are counted from the day each charge was made, and a payment settles the oldest charge first. Customers
            in credit are not listed — they are not a debt, and letting them offset the total would understate what you
            are owed.
          </p>
        </>
      )}
    </ReportShell>
  );
}