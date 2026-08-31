import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { paymentMethodLabel } from "@/lib/validation/sales";

export const metadata = { title: "Dashboard" };

/** Midnight this morning, local time, as an ISO instant. */
function startOfToday(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** Midnight on the first of this month, local time. */
function startOfMonth(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

interface SummaryRow {
  sale_count: number | string;
  gross_total: number | string;
  refunded_total: number | string;
  net_total: number | string;
}

interface RecentSale {
  id: string;
  receipt_number: string;
  status: string;
  payment_method: string;
  total: number | string;
  created_at: string;
  cashier: { first_name: string | null; last_name: string | null } | null;
}

export default async function DashboardPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canSell, canReport, canViewInventory, canViewCustomers, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.SALES_PROCESS),
    hasPermission(supabase, businessId, PERMISSIONS.REPORTS_VIEW),
    hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_VIEW),
    hasPermission(supabase, businessId, PERMISSIONS.CUSTOMERS_VIEW),
    supabase.from("businesses").select("name, currency_code").eq("id", businessId).maybeSingle(),
  ]);

  const currencyCode = business?.currency_code ?? "GHS";
  const money = (amount: number | string | undefined) => formatMoney(toMinorUnits(amount ?? 0), currencyCode);

  // Takings are a money figure: a cashier processes sales without
  // necessarily being trusted with the day's totals, so this is
  // reports.view, the same permission the sales history uses.
  const canSeeMoney = canReport;

  const [{ data: todayRows }, { data: monthRows }, { data: snapshotRows }, { data: recent }] = await Promise.all([
    canSeeMoney
      ? supabase.rpc("sales_summary", { p_from: startOfToday(), p_to: null, p_status: null, p_branch_id: null })
      : Promise.resolve({ data: null }),
    canSeeMoney
      ? supabase.rpc("sales_summary", { p_from: startOfMonth(), p_to: null, p_status: null, p_branch_id: null })
      : Promise.resolve({ data: null }),
    supabase.rpc("dashboard_snapshot"),
    supabase
      .from("sales")
      .select(
        "id, receipt_number, status, payment_method, total, created_at, cashier:profiles!sales_cashier_id_fkey(first_name, last_name)"
      )
      .order("created_at", { ascending: false })
      .limit(6),
  ]);

  const today = ((todayRows ?? []) as unknown as SummaryRow[])[0];
  const month = ((monthRows ?? []) as unknown as SummaryRow[])[0];
  const snapshot = ((snapshotRows ?? []) as unknown as {
    owed_total: number | string;
    owing_customers: number | string;
    low_stock_count: number | string;
    awaiting_payment_count: number | string;
    low_stock_threshold: number | string;
  }[])[0];

  const recentSales = (recent ?? []) as unknown as RecentSale[];
  const waiting = Number(snapshot?.awaiting_payment_count ?? 0);
  const lowStock = Number(snapshot?.low_stock_count ?? 0);
  const owed = Number(snapshot?.owed_total ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{business?.name ?? "Busihub"}</h1>
          <p className="text-neutral-500">
            {new Date().toLocaleDateString("en-GB", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </p>
        </div>
        {canSell ? (
          <Link href="/till">
            <Button>Open the till</Button>
          </Link>
        ) : null}
      </div>

      {/* Things that need doing, before things that merely happened. A
          sale waiting for payment is holding stock off the shelf, so it
          is the one number worth interrupting someone about. */}
      {waiting > 0 || lowStock > 0 ? (
        <div className="flex flex-col gap-2">
          {waiting > 0 ? (
            <Link
              href={{ pathname: "/sales", query: { status: "awaiting_payment" } }}
              className="flex items-center justify-between rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950/60"
            >
              <span>
                <span className="font-semibold">{waiting}</span>{" "}
                {waiting === 1 ? "sale is" : "sales are"} still waiting for payment, holding stock off the shelf.
              </span>
              <span aria-hidden="true">→</span>
            </Link>
          ) : null}
          {canViewInventory && lowStock > 0 ? (
            <Link
              href="/inventory"
              className="flex items-center justify-between rounded-xl bg-neutral-100 px-4 py-3 text-sm text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
            >
              <span>
                <span className="font-semibold">{lowStock}</span>{" "}
                {lowStock === 1 ? "product is" : "products are"} down to{" "}
                {String(snapshot?.low_stock_threshold ?? 5)} or fewer.
              </span>
              <span aria-hidden="true">→</span>
            </Link>
          ) : null}
        </div>
      ) : null}

      {canSeeMoney ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Today", value: money(today?.net_total), sub: `${Number(today?.sale_count ?? 0)} sales` },
            {
              label: "This month",
              value: money(month?.net_total),
              sub: `${Number(month?.sale_count ?? 0)} sales`,
            },
            {
              label: "Returned today",
              value: money(today?.refunded_total),
              sub: Number(today?.refunded_total ?? 0) > 0 ? "off today's takings" : "nothing back",
            },
            {
              label: "Owed to you",
              value: canViewCustomers ? money(owed) : "—",
              sub: canViewCustomers
                ? `${Number(snapshot?.owing_customers ?? 0)} on account`
                : "needs customer access",
            },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <p className="text-xs uppercase text-neutral-500">{card.label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{card.value}</p>
              <p className="mt-0.5 text-xs text-neutral-500">{card.sub}</p>
            </div>
          ))}
        </div>
      ) : null}

      <div>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Latest sales</h2>
          {canSell || canReport ? (
            <Link href="/sales" className="text-sm text-brand-700 hover:underline dark:text-brand-300">
              See all
            </Link>
          ) : null}
        </div>
        <div className="mt-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {recentSales.length > 0 ? (
              recentSales.map((sale) => {
                const cashier = [sale.cashier?.first_name, sale.cashier?.last_name].filter(Boolean).join(" ");
                return (
                  <li key={sale.id}>
                    <Link
                      href={`/sales/${sale.id}`}
                      className="flex items-center justify-between px-5 py-3 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                    >
                      <span>
                        <span className="font-medium">{sale.receipt_number}</span>
                        <span className="ml-2 text-neutral-500">
                          {new Date(sale.created_at).toLocaleTimeString("en-GB", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          {cashier ? ` · ${cashier}` : ""}
                          {sale.status !== "completed" ? ` · ${sale.status.replace("_", " ")}` : ""}
                        </span>
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="hidden text-xs text-neutral-500 sm:inline">
                          {paymentMethodLabel(sale.payment_method)}
                        </span>
                        <span className="font-medium tabular-nums">{money(sale.total)}</span>
                      </span>
                    </Link>
                  </li>
                );
              })
            ) : (
              <li className="px-5 py-10 text-center text-neutral-500">
                Nothing sold yet. {canSell ? "Open the till to ring one up." : ""}
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
