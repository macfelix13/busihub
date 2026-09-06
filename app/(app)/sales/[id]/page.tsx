import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { formatQuantity } from "@/lib/validation/inventory";
import { paymentMethodLabel, momoNetworkLabel } from "@/lib/validation/sales";
import { refundMethodLabel } from "@/lib/validation/refunds";
import { StatusToggleButton } from "../../products/status-toggle-button";
import { voidSale } from "../actions";
import { AwaitingPayment } from "../awaiting-payment";

export const metadata = { title: "Sale" };

interface SaleRow {
  id: string;
  receipt_number: string;
  status: string;
  payment_method: string;
  subtotal: number | string;
  tax_total: number | string;
  total: number | string;
  amount_tendered: number | string;
  change_given: number | string;
  created_at: string;
  branches: { name: string } | null;
  customers: { id: string; name: string } | null;
  cashier: { first_name: string | null; last_name: string | null } | null;
}

interface ItemRow {
  id: string;
  description: string;
  sku: string | null;
  quantity: number | string;
  unit_price: number | string;
  line_total: number | string;
  // Who rendered this line, if it was a service (migration 0040) — a
  // business fact recorded on the line, not who is signed in. sale_items
  // has no other FK to profiles, so this embed needs no disambiguating
  // constraint name, unlike sales.cashier above.
  rendered_by: { first_name: string | null; last_name: string | null } | null;
}

export default async function SaleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canSell, canReport, canVoid, canRefund, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.SALES_PROCESS),
    hasPermission(supabase, businessId, PERMISSIONS.REPORTS_VIEW),
    hasPermission(supabase, businessId, PERMISSIONS.SALES_VOID),
    hasPermission(supabase, businessId, PERMISSIONS.SALES_REFUND),
    supabase.from("businesses").select("name, currency_code").eq("id", businessId).maybeSingle(),
  ]);

  if (!canSell && !canReport) {
    redirect("/dashboard");
  }

  const currencyCode = business?.currency_code ?? "GHS";

  // sales has one FK to profiles (cashier_id) and one to customers, so
  // these embeds are unambiguous; created_by is not embedded here, which
  // is what keeps it that way.
  //
  // All four queries below key off `id` (the route param) alone — none
  // needs another's result — so they run together rather than as four
  // round trips stacked one after another. RLS still scopes each one
  // independently; running them concurrently changes nothing about who
  // can see what, only how long it takes to find out.
  const [
    { data: saleData, error },
    { data: items, error: itemsError },
    { data: paymentRows, error: paymentsError },
    { data: refunds, error: refundsError },
  ] = await Promise.all([
    supabase
      .from("sales")
      .select(
        "id, receipt_number, status, payment_method, subtotal, tax_total, total, amount_tendered, change_given, created_at, branches(name), customers(id, name), cashier:profiles!sales_cashier_id_fkey(first_name, last_name)"
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("sale_items")
      .select("id, description, sku, quantity, unit_price, line_total, rendered_by:profiles(first_name, last_name)")
      .eq("sale_id", id),
    supabase
      .from("sale_payments")
      .select("id, method, amount, status, momo_number, momo_network, failure_reason")
      .eq("sale_id", id)
      .order("created_at"),
    supabase
      .from("refunds")
      .select("id, refund_number, method, reason, total, created_at")
      .eq("sale_id", id)
      .order("created_at", { ascending: false }),
  ]);

  if (error) {
    console.error("SaleDetailPage: query failed", error);
  }

  if (!saleData) {
    notFound();
  }

  const sale = saleData as unknown as SaleRow;

  if (itemsError) {
    console.error("SaleDetailPage: items query failed", itemsError);
  }

  if (paymentsError) {
    console.error("SaleDetailPage: payments query failed", paymentsError);
  }

  if (refundsError) {
    console.error("SaleDetailPage: refunds query failed", refundsError);
  }

  const rows = (items ?? []) as unknown as ItemRow[];
  const refundRows = (refunds ?? []) as unknown as {
    id: string;
    refund_number: string;
    method: string;
    reason: string | null;
    total: number | string;
    created_at: string;
  }[];
  const payments = (paymentRows ?? []) as unknown as {
    id: string;
    method: string;
    amount: number | string;
    status: string;
    momo_number: string | null;
    momo_network: string | null;
    failure_reason: string | null;
  }[];
  const refundedTotal = refundRows.reduce((sum, r) => sum + Number(r.total), 0);
  const isVoided = sale.status === "voided";
  const isAwaiting = sale.status === "awaiting_payment";
  const isCancelled = sale.status === "cancelled";
  const pendingMomo = payments.find((p) => p.method === "momo" && p.status === "pending");
  const cashierName = [sale.cashier?.first_name, sale.cashier?.last_name].filter(Boolean).join(" ");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{sale.receipt_number}</h1>
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
              {paymentMethodLabel(sale.payment_method)}
            </span>
            {isVoided ? (
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
                Voided
              </span>
            ) : null}
            {isAwaiting ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                Waiting for payment
              </span>
            ) : null}
            {isCancelled ? (
              <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                Cancelled
              </span>
            ) : null}
          </div>
          <p className="text-neutral-500">
            {new Date(sale.created_at).toLocaleString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
            {sale.branches?.name ? ` · ${sale.branches.name}` : ""}
            {cashierName ? ` · ${cashierName}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canRefund && sale.status === "completed" ? (
            <Link href={`/sales/${sale.id}/refund`}>
              <Button variant="secondary">Return items</Button>
            </Link>
          ) : null}
          {/* Voiding is for a sale rung up in error, and is refused once
              anything has been returned against it — so it disappears the
              moment a refund exists, rather than offering a button that
              can only fail. */}
          {canVoid && sale.status === "completed" && refundRows.length === 0 ? (
            <StatusToggleButton
              action={voidSale.bind(null, sale.id)}
              label="Void sale"
              pendingLabel="Voiding…"
              variant="danger"
            />
          ) : null}
          <Link href={`/sales/${sale.id}/receipt`}>
            <Button variant="secondary">Receipt</Button>
          </Link>
          <Link href="/till">
            <Button>Next sale</Button>
          </Link>
        </div>
      </div>

      {isAwaiting && pendingMomo ? (
        <AwaitingPayment
          saleId={sale.id}
          momoNumber={pendingMomo.momo_number}
          networkLabel={momoNetworkLabel(pendingMomo.momo_network ?? "")}
          amount={formatMoney(toMinorUnits(pendingMomo.amount), currencyCode)}
          canCancel={canSell}
        />
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase text-neutral-500 dark:border-neutral-800">
              <tr>
                <th className="px-4 py-3 font-medium">Item</th>
                <th className="px-4 py-3 text-right font-medium">Qty</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {rows.map((item) => (
                <tr key={item.id}>
                  <td className="px-4 py-3">
                    <span className="font-medium">{item.description}</span>
                    {item.sku ? <span className="ml-2 text-neutral-500">{item.sku}</span> : null}
                    {item.rendered_by ? (
                      <p className="mt-0.5 text-xs text-neutral-500">
                        Rendered by {[item.rendered_by.first_name, item.rendered_by.last_name].filter(Boolean).join(" ") || "—"}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatQuantity(item.quantity)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatMoney(toMinorUnits(item.unit_price), currencyCode)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatMoney(toMinorUnits(item.line_total), currencyCode)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-neutral-200 dark:border-neutral-800">
              <tr>
                <td colSpan={3} className="px-4 py-2 text-right text-neutral-500">
                  Subtotal (excluding tax)
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatMoney(toMinorUnits(sale.subtotal), currencyCode)}
                </td>
              </tr>
              <tr>
                <td colSpan={3} className="px-4 py-2 text-right text-neutral-500">
                  Tax
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatMoney(toMinorUnits(sale.tax_total), currencyCode)}
                </td>
              </tr>
              <tr>
                <td colSpan={3} className="px-4 py-3 text-right font-semibold">
                  Total
                </td>
                <td className="px-4 py-3 text-right text-lg font-semibold tabular-nums">
                  {formatMoney(toMinorUnits(sale.total), currencyCode)}
                </td>
              </tr>
              {sale.payment_method === "cash" ? (
                <>
                  <tr>
                    <td colSpan={3} className="px-4 py-2 text-right text-neutral-500">
                      Cash received
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatMoney(toMinorUnits(sale.amount_tendered), currencyCode)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={3} className="px-4 py-2 text-right text-neutral-500">
                      Change
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatMoney(toMinorUnits(sale.change_given), currencyCode)}
                    </td>
                  </tr>
                </>
              ) : (
                <tr>
                  <td colSpan={3} className="px-4 py-2 text-right text-neutral-500">
                    On account
                  </td>
                  <td className="px-4 py-2 text-right">
                    {sale.customers ? (
                      <Link href={`/customers/${sale.customers.id}`} className="hover:underline">
                        {sale.customers.name}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      </div>

      {isVoided ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          This sale was voided. The stock went back and any charge to the customer was reversed. The record above is
          kept exactly as it was rung up.
        </p>
      ) : null}

      {payments.length > 0 ? (
        <div>
          <h2 className="font-semibold">How it was paid</h2>
          <div className="mt-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {payments.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <span>
                    <span className="font-medium">{paymentMethodLabel(p.method)}</span>
                    {p.momo_number ? (
                      <span className="ml-2 text-neutral-500">
                        {p.momo_number} · {momoNetworkLabel(p.momo_network ?? "")}
                      </span>
                    ) : null}
                    {p.failure_reason ? (
                      <span className="ml-2 text-red-600 dark:text-red-400">{p.failure_reason}</span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-xs uppercase text-neutral-500">{p.status}</span>
                    <span className="font-medium tabular-nums">
                      {formatMoney(toMinorUnits(p.amount), currencyCode)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {isCancelled ? (
        <p className="rounded-xl bg-neutral-100 px-3.5 py-2.5 text-sm text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          This sale was cancelled before it was paid for. The items went back on the shelf and nothing was charged.
        </p>
      ) : null}

      {refundRows.length > 0 ? (
        <div>
          <h2 className="font-semibold">Returns against this sale</h2>
          <div className="mt-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {refundRows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{r.refund_number}</span>
                    <span className="ml-2 text-neutral-500">{refundMethodLabel(r.method)}</span>
                    {r.reason ? <span className="ml-2 text-neutral-500">· {r.reason}</span> : null}
                  </span>
                  <span className="whitespace-nowrap font-medium tabular-nums text-red-600 dark:text-red-400">
                    −{formatMoney(toMinorUnits(r.total), currencyCode)}
                  </span>
                </li>
              ))}
              <li className="flex items-center justify-between bg-neutral-50 px-5 py-3 text-sm font-medium dark:bg-neutral-800/50">
                <span>Net after returns</span>
                <span className="tabular-nums">
                  {formatMoney(toMinorUnits(Number(sale.total) - refundedTotal), currencyCode)}
                </span>
              </li>
            </ul>
          </div>
        </div>
      ) : null}

      <p className="text-sm text-neutral-500">
        Every figure here was calculated by the server from the catalog price and your tax settings at the moment of
        sale. This record cannot be edited — a correction is a return or a void, each of which gets its own row.
      </p>
    </div>
  );
}