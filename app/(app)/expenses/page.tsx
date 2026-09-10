import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { paidFromLabel } from "@/lib/validation/expenses";

export const metadata = { title: "Expenses" };

const PAGE_SIZE = 50;

interface ExpenseRow {
  id: string;
  reference_number: string;
  description: string;
  amount: number | string;
  expense_date: string;
  paid_from: string;
  status: string;
  branches: { name: string } | null;
  expense_categories: { name: string } | null;
  recorder: { first_name: string | null; last_name: string | null } | null;
}

/** A YYYY-MM-DD from a date input, or null. */
function dateParam(value: string | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; category?: string; status?: string; page?: string }>;
}) {
  const { from, to, category, status, page } = await searchParams;
  const pageNumber = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);
  const fromDate = dateParam(from);
  const toDate = dateParam(to);
  const showVoided = status === "voided";

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canView, canCreate, { data: business }, { data: categoryRows }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.EXPENSES_VIEW),
    hasPermission(supabase, businessId, PERMISSIONS.EXPENSES_CREATE),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
    supabase.from("expense_categories").select("id, name").eq("status", "active").order("name"),
  ]);

  // RLS returns nothing to someone without expenses.view, so this only
  // decides whether they get a page or a redirect rather than an empty
  // table they cannot explain.
  if (!canView) {
    redirect("/dashboard");
  }

  const currencyCode = business?.currency_code ?? "GHS";
  const money = (amount: number | string | undefined) => formatMoney(toMinorUnits(amount ?? 0), currencyCode);
  const categories = (categoryRows ?? []) as unknown as { id: string; name: string }[];
  const activeCategory = categories.some((c) => c.id === category) ? category! : null;

  let query = supabase
    .from("expenses")
    .select(
      "id, reference_number, description, amount, expense_date, paid_from, status, branches(name), expense_categories(name), recorder:profiles!expenses_recorded_by_fkey(first_name, last_name)",
      { count: "exact" }
    )
    .order("expense_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE - 1);

  if (fromDate) query = query.gte("expense_date", fromDate);
  if (toDate) query = query.lte("expense_date", toDate);
  if (activeCategory) query = query.eq("category_id", activeCategory);
  query = query.eq("status", showVoided ? "voided" : "recorded");

  const [{ data: rows, error, count }, { data: summaryRows, error: summaryError }, { data: byCategoryRows }] =
    await Promise.all([
      query,
      // Totals over the WHOLE filtered period, not this page. Adding up
      // the visible rows would report "GH₵400 spent" on a month that was
      // GH₵4,000 across four pages (the same reasoning as sales_summary).
      supabase.rpc("expense_summary", { p_from: fromDate, p_to: toDate, p_branch_id: null }),
      supabase.rpc("expenses_by_category", {
        p_from: fromDate,
        p_to: toDate,
        p_branch_id: null,
        p_limit: 6,
      }),
    ]);

  if (error) console.error("ExpensesPage: query failed", error);
  if (summaryError) console.error("ExpensesPage: summary failed", summaryError);

  const expenses = (rows ?? []) as unknown as ExpenseRow[];
  const summary = ((summaryRows ?? []) as unknown as {
    expense_total: number | string;
    expense_count: number | string;
    cash_paid_out: number | string;
  }[])[0];
  const byCategory = (byCategoryRows ?? []) as unknown as {
    category_id: string | null;
    category_name: string;
    amount: number | string;
    expense_count: number | string;
  }[];

  const totalCount = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const linkQuery = (overrides: Record<string, string | undefined>) => {
    const params: Record<string, string> = {};
    if (fromDate) params.from = fromDate;
    if (toDate) params.to = toDate;
    if (activeCategory) params.category = activeCategory;
    if (showVoided) params.status = "voided";
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete params[key];
      else params[key] = value;
    }
    return params;
  };

  const biggest = Number(byCategory[0]?.amount ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Expenses</h1>
          <p className="text-neutral-500">Money that has left the business.</p>
        </div>
        {canCreate ? (
          <Link href="/expenses/new">
            <Button>Record expense</Button>
          </Link>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          { label: "Total", value: money(summary?.expense_total), sub: `${Number(summary?.expense_count ?? 0)} recorded` },
          {
            label: "Paid in cash",
            value: money(summary?.cash_paid_out),
            sub: "out of the till",
          },
          {
            label: "Biggest category",
            value: byCategory[0]?.category_name ?? "—",
            sub: byCategory[0] ? money(byCategory[0].amount) : "nothing yet",
          },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <p className="text-xs uppercase text-neutral-500">{card.label}</p>
            <p className="mt-1 truncate text-xl font-semibold tabular-nums">{card.value}</p>
            <p className="mt-0.5 text-xs text-neutral-500">{card.sub}</p>
          </div>
        ))}
      </div>

      {byCategory.length > 0 ? (
        <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <h2 className="font-semibold">Where the money went</h2>
          <ul className="mt-4 flex flex-col gap-3">
            {byCategory.map((row) => {
              const amount = Number(row.amount ?? 0);
              const share = biggest > 0 ? (amount / biggest) * 100 : 0;
              return (
                <li key={row.category_id ?? row.category_name}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate font-medium">{row.category_name}</span>
                    <span className="flex-shrink-0 tabular-nums">{money(amount)}</span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                    <div className="h-full rounded-full bg-brand-500" style={{ width: `${share}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* A plain GET form, so a particular month is a URL that can be
          bookmarked or sent to whoever does the books. */}
      <form method="get" className="flex flex-wrap items-end gap-3">
        {activeCategory ? <input type="hidden" name="category" value={activeCategory} /> : null}
        {showVoided ? <input type="hidden" name="status" value="voided" /> : null}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-800 dark:text-neutral-200">From</span>
          <input
            type="date"
            name="from"
            defaultValue={fromDate ?? ""}
            className="min-h-[44px] rounded-xl border border-neutral-300 bg-white px-3 py-2 text-base dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-800 dark:text-neutral-200">To</span>
          <input
            type="date"
            name="to"
            defaultValue={toDate ?? ""}
            className="min-h-[44px] rounded-xl border border-neutral-300 bg-white px-3 py-2 text-base dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
        {fromDate || toDate || activeCategory ? (
          <Link href="/expenses" className="self-center text-sm text-brand-700 hover:underline dark:text-brand-300">
            Clear
          </Link>
        ) : null}
      </form>

      <div className="flex flex-wrap items-center gap-1">
        <SegmentedControl
          className="self-start"
          options={[
            {
              key: "recorded",
              label: "Recorded",
              active: !showVoided,
              href: { pathname: "/expenses", query: linkQuery({ status: undefined, page: undefined }) },
            },
            {
              key: "voided",
              label: "Voided",
              active: showVoided,
              href: { pathname: "/expenses", query: linkQuery({ status: "voided", page: undefined }) },
            },
          ]}
        />
        {categories.length > 0 ? (
          <span className="mx-1 self-center text-neutral-300 dark:text-neutral-700" aria-hidden="true">
            |
          </span>
        ) : null}
        {activeCategory ? (
          <Link
            href={{ pathname: "/expenses", query: linkQuery({ category: undefined, page: undefined }) }}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-300"
          >
            All categories
          </Link>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        {error ? (
          <p className="px-5 py-10 text-center text-neutral-500">
            These expenses couldn&rsquo;t be loaded. Reload the page, or try again in a moment.
          </p>
        ) : expenses.length > 0 ? (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {expenses.map((expense) => {
              const recorder = [expense.recorder?.first_name, expense.recorder?.last_name]
                .filter(Boolean)
                .join(" ");
              return (
                <li key={expense.id}>
                  <Link
                    href={`/expenses/${expense.id}`}
                    className="flex items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {expense.description}
                        {expense.status === "voided" ? (
                          <span className="ml-2 rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                            Voided
                          </span>
                        ) : null}
                      </span>
                      <span className="block truncate text-xs text-neutral-500">
                        {new Date(`${expense.expense_date}T00:00:00`).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                        {" · "}
                        {expense.expense_categories?.name ?? "Uncategorised"}
                        {" · "}
                        {paidFromLabel(expense.paid_from)}
                        {expense.branches?.name ? ` · ${expense.branches.name}` : ""}
                        {recorder ? ` · ${recorder}` : ""}
                      </span>
                    </span>
                    <span className="whitespace-nowrap text-right">
                      <span
                        className={`block font-medium tabular-nums ${
                          expense.status === "voided" ? "text-neutral-400 line-through dark:text-neutral-600" : ""
                        }`}
                      >
                        {money(expense.amount)}
                      </span>
                      <span className="text-xs text-neutral-500">{expense.reference_number}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-5 py-12 text-center text-neutral-500">
            {showVoided
              ? "No voided expenses."
              : fromDate || toDate || activeCategory
                ? "No expenses match these filters."
                : "Nothing recorded yet. Rent, wages, light, water — anything that leaves the business belongs here."}
          </p>
        )}
      </div>

      {lastPage > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-neutral-500">
            Page {pageNumber} of {lastPage} · {totalCount} expenses
          </span>
          <div className="flex gap-2">
            {pageNumber > 1 ? (
              <Link
                href={{ pathname: "/expenses", query: linkQuery({ page: String(pageNumber - 1) }) }}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 dark:border-neutral-800"
              >
                Previous
              </Link>
            ) : null}
            {pageNumber < lastPage ? (
              <Link
                href={{ pathname: "/expenses", query: linkQuery({ page: String(pageNumber + 1) }) }}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 dark:border-neutral-800"
              >
                Next
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}