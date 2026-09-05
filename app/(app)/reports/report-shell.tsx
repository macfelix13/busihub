import Link from "next/link";
import { RANGES, type Period } from "@/lib/reports/period";
import { ReportControls } from "./report-controls";

/**
 * The frame every report shares: a heading, the period and branch
 * pickers, the print/copy/CSV controls, and a printed header that only
 * appears on paper.
 *
 * The printed header matters more than it looks. A report handed to a
 * bank or a landlord with no shop name, no period and no date on it is
 * an anonymous list of numbers — and the screen version does not need
 * any of that, because the person reading it just chose the period. So
 * it is `hidden print:block`: absent on screen, first thing on the page.
 *
 * Everything outside `.report-sheet` is hidden when printing (see
 * app/globals.css), so the filters and buttons cannot end up on paper.
 */

export interface BranchOption {
  id: string;
  name: string;
}

interface ReportShellProps {
  title: string;
  description: string;
  shopName: string;
  period: Period;
  /** Which branch is selected, or null for all of them. */
  branchId: string | null;
  branches: BranchOption[];
  /** The route these filters point back at, e.g. "/reports/profit-loss". */
  pathname: string;
  /** Plain text for the clipboard. */
  shareText: string;
  csvHref?: string;
  /** Hidden when a report is not about a date range (stock on hand). */
  showPeriod?: boolean;
  children: React.ReactNode;
}

export function ReportShell({
  title,
  description,
  shopName,
  period,
  branchId,
  branches,
  pathname,
  shareText,
  csvHref,
  showPeriod = true,
  children,
}: ReportShellProps) {
  const branchName = branches.find((b) => b.id === branchId)?.name ?? null;

  const linkQuery = (overrides: Record<string, string | undefined>) => {
    const query: Record<string, string> = {};
    if (showPeriod && period.range !== "today") query.range = period.range;
    if (branchId) query.branch = branchId;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete query[key];
      else query[key] = value;
    }
    return query;
  };

  const tabClass = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${
      active
        ? "bg-brand-600 text-white"
        : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white"
    }`;

  return (
    <div className="flex flex-col gap-6">
      <div className="print:hidden">
        <Link href="/reports" className="text-sm text-brand-700 hover:underline dark:text-brand-300">
          ← All reports
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{title}</h1>
            <p className="text-neutral-500">{description}</p>
          </div>
          <ReportControls text={shareText} csvHref={csvHref} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 print:hidden">
        {showPeriod ? (
          <div className="flex flex-wrap gap-1 rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
            {RANGES.map((option) => (
              <Link
                key={option.value}
                href={{ pathname, query: linkQuery({ range: option.value }) }}
                className={tabClass(period.range === option.value)}
              >
                {option.label}
              </Link>
            ))}
          </div>
        ) : null}

        {branches.length > 1 ? (
          <div className="flex flex-wrap gap-1 rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
            <Link
              href={{ pathname, query: linkQuery({ branch: undefined }) }}
              className={tabClass(branchId === null)}
            >
              All branches
            </Link>
            {branches.map((branch) => (
              <Link
                key={branch.id}
                href={{ pathname, query: linkQuery({ branch: branch.id }) }}
                className={tabClass(branchId === branch.id)}
              >
                {branch.name}
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      <div className="report-sheet flex flex-col gap-5">
        {/* Paper only. On screen the person just chose these; on paper
            they are the difference between a statement and a list of
            numbers with no provenance. */}
        <header className="hidden print:block">
          <h2 className="text-lg font-semibold">{shopName}</h2>
          <p className="text-sm">{title}</p>
          <p className="text-sm">
            {showPeriod ? period.label : "as it stands today"}
            {branchName ? ` · ${branchName}` : branches.length > 1 ? " · all branches" : ""}
          </p>
          <p className="text-xs">
            Prepared{" "}
            {new Date().toLocaleString("en-GB", {
              timeZone: period.timezone,
              day: "numeric",
              month: "long",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
          <hr className="mt-3" />
        </header>

        {children}
      </div>
    </div>
  );
}

/** A labelled figure, used by several reports. */
export function StatementLine({
  label,
  value,
  note,
  emphasis = false,
  rule = false,
  negative = false,
}: {
  label: string;
  value: string;
  note?: string;
  emphasis?: boolean;
  rule?: boolean;
  negative?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 py-2 ${
        rule ? "border-t border-neutral-300 dark:border-neutral-700" : ""
      }`}
    >
      <span className={`min-w-0 break-words ${emphasis ? "font-semibold" : ""}`}>
        {label}
        {note ? <span className="ml-2 text-xs text-neutral-500">{note}</span> : null}
      </span>
      <span
        className={`flex-shrink-0 tabular-nums ${emphasis ? "text-lg font-semibold" : ""} ${
          negative ? "text-red-600 dark:text-red-400" : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
}