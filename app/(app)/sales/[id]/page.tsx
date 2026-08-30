import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { formatQuantity } from "@/lib/validation/inventory";
import { paymentMethodLabel } from "@/lib/validation/sales";

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
}

export default async function SaleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canSell, canReport, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.SALES_PROCESS),
    hasPermission(supabase, businessId, PERMISSIONS.REPORTS_VIEW),
    supabase.from("businesses").select("name, currency_code").eq("id", businessId).maybeSingle(),
  ]);

  if (!canSell && !canReport) {
    redirect("/dashboard");
  }

  const currencyCode = business?.currency_code ?? "GHS";

  // sales has one FK to profiles (cashier_id) and one to customers, so
  // these embeds are unambiguous; created_by is not embedded here, which
  // is what keeps it that way.
  const { data: saleData, error } = await supabase
    .from("sales")
    .select(
      "id, receipt_number, status, payment_method, subtotal, tax_total, total, amount_tendered, change_given, created_at, branches(name), customers(id, name), cashier:profiles!sales_cashier_id_fkey(first_name, last_name)"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("SaleDetailPage: query failed", error);
  }

  if (!saleData) {
    notFound();
  }

  const sale = saleData as unknown as SaleRow;

  const { data: items, error: itemsError } = await supabase
    .from("sale_items")
    .select("id, description, sku, quantity, unit_price, line_total")
    .eq("sale_id", id);

  if (itemsError) {
    console.error("SaleDetailPage: items query failed", itemsError);
  }

  const rows = (items ?? []) as unknown as ItemRow[];
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
        <Link href="/till">
          <Button>Next sale</Button>
        </Link>
      </div>

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

      <p className="text-sm text-neutral-500">
        Every figure here was calculated by the server from the catalog price and your tax settings at the moment of
        sale. This record cannot be edited — a correction is a refund or a void.
      </p>
    </div>
  );
}
