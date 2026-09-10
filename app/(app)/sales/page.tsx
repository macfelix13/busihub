import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertCircle, Receipt } from "lucide-react";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { paymentMethodLabel } from "@/lib/validation/sales";

export const metadata = { title: "Sales" };

const PAGE_SIZE = 50;

const STATUS_TABS = [
  { value: "", label: "All" },
  { value: "completed", label: "Completed" },
  { value: "awaiting_payment", label: "Waiting for payment" },
  { value: "voided", label: "Voided" },
  { value: "cancelled", label: "Cancelled" },
] as const;

// The shared Badge component's variants — same green/amber/red/neutral
// hues STATUS_CLASSES used to hand-roll, now the one token set the rest
// of the app already uses (e.g. the dashboard's low-stock pills). The
// chip background normalizes a shade lighter in the process (e.g.
// completed's bg-green-100 -> Badge's bg-green-50) to match that shared
// token exactly, rather than keeping a second, slightly darker green
// pill that existed only on this page.
const STATUS_BADGE: Record<string, BadgeVariant> = {
  completed: "success",
  awaiting_payment: "warning",
  voided: "danger",
  cancelled: "neutral",
};

const STATUS_LABELS: Record<string, string> = {
  completed: "Completed",
  awaiting_payment: "Waiting",
  voided: "Voided",
  cancelled: "Cancelled",
};

interface SaleRow {
  id: string;
  receipt_number: string;
  status: string;
  payment_method: string;
  total: number | string;
  created_at: string;
  branches: { name: string } | null;
  customers: { name: string } | null;
  cashier: { first_name: string | null; last_name: string | null } | null;
}

/** Local date (YYYY-MM-DD) from a date input, as the start of that day. */
function startOfDay(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The instant AFTER the given day, so "to" is inclusive of that whole day. */
function endOfDay(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + 1);
  return date.toISOString();
}

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; from?: string; to?: string; q?: string; page?: string }>;
}) {
  const { status, from, to, q, page } = await searchParams;

  const activeStatus = STATUS_TABS.some((s) => s.value === status && s.value !== "") ? status! : null;
  const search = (q ?? "").trim();
  const pageNumber = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canSell, canReport, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.SALES_PROCESS),
    hasPermission(supabase, businessId, PERMISSIONS.REPORTS_VIEW),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
  ]);

  if (!canSell && !canReport) {
    redirect("/dashboard");
  }

  const currencyCode = business?.currency_code ?? "GHS";
  const fromIso = startOfDay(from);
  const toIso = endOfDay(to);

  let query = supabase
    .from("sales")
    .select(
      "id, receipt_number, status, payment_method, total, created_at, branches(name), customers(name), cashier:profiles!sales_cashier_id_fkey(first_name, last_name)",
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE - 1);

  if (activeStatus) query = query.eq("status", activeStatus);
  if (fromIso) query = query.gte("created_at", fromIso);
  if (toIso) query = query.lt("created_at", toIso);
  // Receipt numbers are short and typed from a printed slip, so a prefix
  // match on the number is what a person actually wants here.
  if (search) query = query.ilike("receipt_number", `%${search}%`);

  const [{ data: sales, error, count }, { data: summaryRows, error: summaryError }] = await Promise.all([
    query,
    // Totals over the WHOLE filtered period, not just this page — adding
    // up the visible rows would understate a busy day (migration 0027).
    supabase.rpc("sales_summary", {
      p_from: fromIso,
      p_to: toIso,
      p_status: activeStatus,
      p_branch_id: null,
    }),
  ]);

  if (error) console.error("SalesPage: query failed", error);
  if (summaryError) console.error("SalesPage: summary failed", summaryError);

  const rows = (sales ?? []) as unknown as SaleRow[];
  const summary = ((summaryRows ?? []) as unknown as {
    sale_count: number | string;
    gross_total: number | string;
    refunded_total: number | string;
    net_total: number | string;
  }[])[0];

  const totalCount = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const linkQuery = (overrides: Record<string, string>) => {
    const params: Record<string, string> = {};
    if (activeStatus) params.status = activeStatus;
    if (from) params.from = from;
    if (to) params.to = to;
    if (search) params.q = search;
    return { ...params, ...overrides };
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sales"
        description="Every sale rung up, newest first."
        actions={
          canSell ? (
            <Link href="/till">
              <Button>Open the till</Button>
            </Link>
          ) : null
        }
      />

      {/* Takings for the filtered period. Voided and cancelled sales are
          deliberately absent from these figures — they are still listed
          below, because a history that hides them is not a history. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Sales", value: String(summary?.sale_count ?? 0) },
          { label: "Takings", value: formatMoney(toMinorUnits(summary?.gross_total ?? 0), currencyCode) },
          { label: "Returned", value: formatMoney(toMinorUnits(summary?.refunded_total ?? 0), currencyCode) },
          { label: "Net", value: formatMoney(toMinorUnits(summary?.net_total ?? 0), currencyCode) },
        ].map((card) => (
          <Card key={card.label} className="p-4">
            <p className="text-xs uppercase text-neutral-500">{card.label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{card.value}</p>
          </Card>
        ))}
      </div>

      <SegmentedControl
        className="self-start"
        options={STATUS_TABS.map((tab) => ({
          key: tab.value || "all",
          label: tab.label,
          active: (activeStatus ?? "") === tab.value,
          href: { pathname: "/sales", query: linkQuery(tab.value ? { status: tab.value } : {}) },
        }))}
      />

      {/* A plain GET form: the filters end up in the URL, so a particular
          day's takings can be bookmarked or sent to someone. */}
      <form method="get" className="flex flex-wrap items-end gap-3">
        {activeStatus ? <input type="hidden" name="status" value={activeStatus} /> : null}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-800 dark:text-neutral-200">From</span>
          <input
            type="date"
            name="from"
            defaultValue={from ?? ""}
            className="min-h-[44px] rounded-xl border border-neutral-300 bg-white px-3 py-2 text-base dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-800 dark:text-neutral-200">To</span>
          <input
            type="date"
            name="to"
            defaultValue={to ?? ""}
            className="min-h-[44px] rounded-xl border border-neutral-300 bg-white px-3 py-2 text-base dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-800 dark:text-neutral-200">Receipt number</span>
          <input
            type="search"
            name="q"
            defaultValue={search}
            placeholder="R-000042"
            className="min-h-[44px] rounded-xl border border-neutral-300 bg-white px-3 py-2 text-base dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
        {from || to || search ? (
          <Link href={{ pathname: "/sales", query: activeStatus ? { status: activeStatus } : {} }}>
            <Button type="button" variant="ghost">
              Clear
            </Button>
          </Link>
        ) : null}
      </form>

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span>Couldn&apos;t load sales. Please refresh the page.</span>
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title={from || to || search || activeStatus ? "No sales match those filters" : "No sales yet"}
          description={from || to || search || activeStatus ? undefined : "Ring one up at the till and it will appear here."}
        />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {rows.map((sale) => {
              const cashier = [sale.cashier?.first_name, sale.cashier?.last_name].filter(Boolean).join(" ");
              return (
                <li key={sale.id}>
                  <Link
                    href={`/sales/${sale.id}`}
                    className="flex flex-col gap-1 px-5 py-4 transition-colors hover:bg-neutral-50 sm:flex-row sm:items-center sm:justify-between dark:hover:bg-neutral-800/50"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{sale.receipt_number}</span>
                        <Badge variant={STATUS_BADGE[sale.status] ?? "neutral"}>
                          {STATUS_LABELS[sale.status] ?? sale.status}
                        </Badge>
                        <span className="text-xs text-neutral-500">{paymentMethodLabel(sale.payment_method)}</span>
                      </div>
                      <p className="mt-0.5 text-sm text-neutral-500">
                        {new Date(sale.created_at).toLocaleString("en-GB", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {sale.branches?.name ? ` · ${sale.branches.name}` : ""}
                        {cashier ? ` · ${cashier}` : ""}
                        {sale.customers?.name ? ` · ${sale.customers.name}` : ""}
                      </p>
                    </div>
                    <span className="text-lg font-semibold tabular-nums">
                      {formatMoney(toMinorUnits(sale.total), currencyCode)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {totalCount > PAGE_SIZE ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-neutral-500">
            Page {pageNumber} of {lastPage} · {totalCount} sales
          </span>
          <div className="flex gap-2">
            {pageNumber > 1 ? (
              <Link href={{ pathname: "/sales", query: linkQuery({ page: String(pageNumber - 1) }) }}>
                <Button variant="secondary">Previous</Button>
              </Link>
            ) : null}
            {pageNumber < lastPage ? (
              <Link href={{ pathname: "/sales", query: linkQuery({ page: String(pageNumber + 1) }) }}>
                <Button variant="secondary">Next</Button>
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}