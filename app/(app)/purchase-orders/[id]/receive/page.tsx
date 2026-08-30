import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { ReceiveForm, type ReceiveLine } from "../../receive-form";
import { receivePurchaseOrder } from "../../actions";
import { isReceivable } from "@/lib/validation/purchasing";

export const metadata = { title: "Receive delivery" };

interface ItemRow {
  id: string;
  quantity_ordered: number | string;
  quantity_received: number | string;
  product_variants: {
    sku: string | null;
    variant_options: Record<string, string> | null;
    products: { name: string } | null;
  } | null;
}

export default async function ReceivePurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  // Cosmetic — receivePurchaseOrder() re-checks this server-side, and the
  // database re-checks it again when the movement is inserted (0015).
  if (!(await hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_RECEIVE))) {
    redirect(`/purchase-orders/${id}`);
  }

  const { data: order, error } = await supabase
    .from("purchase_orders")
    .select("id, reference, status, suppliers(name), branches(name)")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("ReceivePurchaseOrderPage: query failed", error);
  }

  if (!order) {
    notFound();
  }

  // Mirrors the database rule — an unapproved or finished order has
  // nothing to receive, so don't render a form that can only fail.
  if (!isReceivable(order.status)) {
    redirect(`/purchase-orders/${id}`);
  }

  const { data: items, error: itemsError } = await supabase
    .from("purchase_order_items")
    .select("id, quantity_ordered, quantity_received, product_variants(sku, variant_options, products(name))")
    .eq("purchase_order_id", id);

  if (itemsError) {
    console.error("ReceivePurchaseOrderPage: items query failed", itemsError);
  }

  const lines: ReceiveLine[] = ((items ?? []) as unknown as ItemRow[])
    .map((item) => {
      const variant = item.product_variants;
      const name = variant?.products?.name ?? "Unknown product";
      const options = Object.entries(variant?.variant_options ?? {});
      const base = options.length > 0 ? `${name} — ${options.map(([, v]) => v).join(" / ")}` : name;
      return {
        itemId: item.id,
        label: variant?.sku ? `${base} (${variant.sku})` : base,
        // numeric(14,3) arrives from PostgREST as a string, not a number.
        ordered: Number(item.quantity_ordered),
        received: Number(item.quantity_received),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const supplierName = (order as unknown as { suppliers: { name: string } | null }).suppliers?.name;
  const branchName = (order as unknown as { branches: { name: string } | null }).branches?.name;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Receive delivery</h1>
        <p className="text-neutral-500">
          {order.reference} · {supplierName ?? "Unknown supplier"} · into {branchName ?? "unknown branch"}
        </p>
      </div>
      <ReceiveForm action={receivePurchaseOrder.bind(null, order.id)} lines={lines} />
    </div>
  );
}
