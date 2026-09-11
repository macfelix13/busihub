import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";

export const metadata = { title: "Reports" };

/**
 * Four reports, described by the question each one answers rather than
 * by its accounting name. "Profit and loss" is what a bank calls it;
 * "did the shop make money" is what the shopkeeper wants to know, and
 * both are on the card.
 */
const REPORTS = [
  {
    href: "/reports/profit-loss",
    title: "Profit and loss",
    question: "Did the shop make money, and where did it go?",
    detail: "Sales, cost of goods, expenses and what is left. The statement a bank or an accountant asks for.",
  },
  {
    href: "/reports/receivables",
    title: "Who owes you",
    question: "Whose money is still out there, and for how long?",
    detail: "Every account customer in debt, split by age, oldest first — so you know who to ring this morning.",
  },
  {
    href: "/reports/stock",
    title: "What your stock is worth",
    question: "How much money is sitting on the shelves?",
    detail: "Everything in stock valued at what you paid and what you would sell it for, biggest holding first.",
  },
  {
    href: "/reports/sales",
    title: "Sales report",
    question: "What sold, how was it paid for, and who sold it?",
    detail: "A fixed period you can print or export, rather than a dashboard you browse.",
  },
] as const;

export default async function ReportsPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canView, canExport] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.REPORTS_VIEW),
    hasPermission(supabase, businessId, PERMISSIONS.REPORTS_EXPORT),
  ]);

  // Cosmetic — every report re-checks this, and RLS returns nothing to
  // someone who should not see the figures regardless.
  if (!canView) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-neutral-500 dark:text-ink-muted">
          Every figure is worked out from your own records. Each one prints, copies for WhatsApp
          {canExport ? ", and downloads as a spreadsheet" : ""}.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {REPORTS.map((report) => (
          <Link
            key={report.href}
            href={report.href}
            className="flex flex-col gap-1 rounded-2xl border border-neutral-200 bg-white p-5 hover:border-brand-300 hover:bg-neutral-50 dark:border-surface-line dark:bg-surface-card dark:hover:border-brand-800 dark:hover:bg-surface/60"
          >
            <h2 className="font-semibold">{report.title}</h2>
            <p className="text-sm font-medium text-neutral-700 dark:text-ink-muted">{report.question}</p>
            <p className="text-sm text-neutral-500 dark:text-ink-muted">{report.detail}</p>
          </Link>
        ))}
      </div>

      {/* Said here rather than discovered later: two of these depend on
          data the shop has to put in, and a report that reads zero is
          otherwise indistinguishable from one that is broken. */}
      <div className="rounded-2xl border border-neutral-200 bg-white p-5 text-sm text-neutral-500 dark:border-surface-line dark:bg-surface-card dark:text-ink-muted">
        <p>
          Profit depends on cost prices being set on your products, and on expenses being recorded. Sales rung up before
          Busihub started tracking costs are marked as estimated on the reports that use them.
        </p>
      </div>
    </div>
  );
}