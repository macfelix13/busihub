import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { RefundForm, type RefundableLine } from "../../refund-form";
import { refundSale } from "../../actions";

export const metadata = { title: "Return" };

interface ItemRow {
  id: string;
  description: string;
  sku: string | null;
  quantity: number | string;
  unit_price: number | string;
  line_total: number | string;
}

export default async function RefundSalePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canRefund, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.SALES_REFUND),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
  ]);

  // Cosmetic — create_refund() and its RLS re-check this server-side.
  if (!canRefund) {
    redirect(`/sales/${id}`);
  }

  const { data: sale, error } = await supabase
    .from("sales")
    .select("id, receipt_number, status, customer_id")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("RefundSalePage: sale query failed", error);
  }

  if (!sale) {
    notFound();
  }

  // Mirrors the database rule: a voided sale has nothing to give back, so
  // don't render a form that can only fail.
  if (sale.status !== "completed") {
    redirect(`/sales/${id}`);
  }

  const [{ data: items, error: itemsError }, { data: refundedRows, error: refundedError }] = await Promise.all([
    supabase.from("sale_items").select("id, description, sku, quantity, unit_price, line_total").eq("sale_id", id),
    // How much of each line has already gone back, across every previous
    // refund — the same cumulative rule create_refund enforces. The inner
    // join on refunds is what scopes this to *this* sale; without it the
    // query would drag back every refund line in the business.
    supabase.from("refund_items").select("sale_item_id, quantity, refunds!inner(sale_id)").eq("refunds.sale_id", id),
  ]);

  if (itemsError) console.error("RefundSalePage: items query failed", itemsError);
  if (refundedError) console.error("RefundSalePage: refunded query failed", refundedError);

  const refundedBySaleItem = new Map<string, number>();
  for (const row of refundedRows ?? []) {
    const r = row as { sale_item_id: string; quantity: number | string };
    refundedBySaleItem.set(r.sale_item_id, (refundedBySaleItem.get(r.sale_item_id) ?? 0) + Number(r.quantity));
  }

  const lines: RefundableLine[] = ((items ?? []) as unknown as ItemRow[]).map((item) => {
    const sold = Number(item.quantity);
    const lineTotal = Number(item.line_total);
    return {
      saleItemId: item.id,
      description: item.description,
      sku: item.sku,
      sold,
      alreadyRefunded: refundedBySaleItem.get(item.id) ?? 0,
      unitPrice: Number(item.unit_price),
      // What one unit actually cost including tax, derived from the line
      // rather than the catalog — the same basis create_refund uses.
      unitTotal: sold > 0 ? lineTotal / sold : 0,
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Return</h1>
        <p className="text-neutral-500">Against {sale.receipt_number}</p>
      </div>
      <RefundForm
        action={refundSale.bind(null, sale.id)}
        lines={lines}
        currencyCode={business?.currency_code ?? "GHS"}
        hasCustomer={Boolean(sale.customer_id)}
      />
    </div>
  );
}
