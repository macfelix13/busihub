import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { StatusToggleButton } from "../../products/status-toggle-button";
import { approvePurchaseOrder, cancelPurchaseOrder } from "../actions";
import { purchaseOrderStatusLabel, isReceivable } from "@/lib/validation/purchasing";
import { formatQuantity } from "@/lib/validation/inventory";

export const metadata = { title: "Purchase order" };

const STATUS_CLASSES: Record<string, string> = {
  draft: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  approved: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  partially_received: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  received: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  cancelled: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

interface ProfileName {
  first_name: string | null;
  last_name: string | null;
}

/**
 * The shape this page reads. Declared explicitly and cast to, rather than
 * relying on supabase-js inferring it from the select string: the select
 * below embeds profiles twice under aliases, and any part of that string
 * the type-level parser can't resolve collapses the whole row type to
 * GenericStringError, which fails to compile in a way that has nothing to
 * do with the actual query. The embeds are already hand-typed here, so
 * the inference was buying nothing.
 */
interface OrderRow {
  id: string;
  reference: string;
  status: string;
  expected_date: string | null;
  notes: string | null;
  created_at: string;
  approved_at: string | null;
  suppliers: { id: string; name: string } | null;
  branches: { id: string; name: string } | null;
  raised_by: ProfileName | null;
  approved_by_profile: ProfileName | null;
}

interface ItemRow {
  id: string;
  quantity_ordered: number | string;
  quantity_received: number | string;
  unit_cost: number | string;
  product_variants: {
    id: string;
    sku: string | null;
    variant_options: Record<string, string> | null;
    products: { name: string } | null;
  } | null;
}

function itemLabel(item: ItemRow): string {
  const variant = item.product_variants;
  const name = variant?.products?.name ?? "Unknown product";
  const options = Object.entries(variant?.variant_options ?? {});
  const base = options.length > 0 ? `${name} — ${options.map(([, v]) => v).join(" / ")}` : name;
  return variant?.sku ? `${base} (${variant.sku})` : base;
}

export default async function PurchaseOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canView, canApprove, canReceive, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.SUPPLIERS_VIEW),
    hasPermission(supabase, businessId, PERMISSIONS.PURCHASE_ORDERS_APPROVE),
    hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_RECEIVE),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
  ]);
  const currencyCode = business?.currency_code ?? "GHS";

  if (!canView) {
    redirect("/dashboard");
  }

  // RLS-scoped: another tenant's order id simply isn't found.
  //
  // purchase_orders has TWO foreign keys to profiles (created_by and
  // approved_by), so a bare `profiles(...)` embed is ambiguous and
  // PostgREST rejects it with PGRST201 — the same failure the (app) layout
  // hit with profiles->businesses. Both are disambiguated by explicit
  // constraint name rather than by column hint.
  //
  // The select string must stay a single string literal: supabase-js
  // derives the row type from it at compile time, and concatenating it
  // (even just to wrap a comment in) widens it to `string` and collapses
  // the inferred row type to GenericStringError, so every field access
  // below fails to typecheck. Hence one long line, comment up here.
  const { data: orderData, error } = await supabase
    .from("purchase_orders")
    .select(
      "id, reference, status, expected_date, notes, created_at, approved_at, suppliers(id, name), branches(id, name), raised_by:profiles!purchase_orders_created_by_fkey(first_name, last_name), approved_by_profile:profiles!purchase_orders_approved_by_fkey(first_name, last_name)"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("PurchaseOrderDetailPage: query failed", error);
  }

  if (!orderData) {
    notFound();
  }

  const order = orderData as unknown as OrderRow;

  const { data: items, error: itemsError } = await supabase
    .from("purchase_order_items")
    .select(
      "id, quantity_ordered, quantity_received, unit_cost, product_variants(id, sku, variant_options, products(name))"
    )
    .eq("purchase_order_id", id);

  if (itemsError) {
    console.error("PurchaseOrderDetailPage: items query failed", itemsError);
  }

  const rows = ((items ?? []) as unknown as ItemRow[]).sort((a, b) => itemLabel(a).localeCompare(itemLabel(b)));
  const total = rows.reduce((sum, r) => sum + Number(r.quantity_ordered) * Number(r.unit_cost), 0);

  const { suppliers: supplier, branches: branch, raised_by: raisedBy, approved_by_profile: approvedBy } = order;

  const receivable = isReceivable(order.status);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{order.reference}</h1>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[order.status] ?? STATUS_CLASSES.draft}`}
            >
              {purchaseOrderStatusLabel(order.status)}
            </span>
          </div>
          <p className="text-neutral-500">
            {supplier ? (
              <Link href={`/suppliers/${supplier.id}`} className="hover:underline">
                {supplier.name}
              </Link>
            ) : (
              "Unknown supplier"
            )}{" "}
            · delivering to {branch?.name ?? "unknown branch"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canApprove && order.status === "draft" ? (
            <StatusToggleButton
              action={approvePurchaseOrder.bind(null, order.id)}
              label="Approve order"
              pendingLabel="Approving…"
            />
          ) : null}
          {canReceive && receivable ? (
            <Link href={`/purchase-orders/${order.id}/receive`}>
              <Button variant={order.status === "draft" ? "secondary" : undefined}>Receive delivery</Button>
            </Link>
          ) : null}
          {canApprove && order.status !== "received" && order.status !== "cancelled" ? (
            <StatusToggleButton
              action={cancelPurchaseOrder.bind(null, order.id)}
              label="Cancel order"
              pendingLabel="Cancelling…"
              variant="danger"
            />
          ) : null}
        </div>
      </div>

      {order.status === "draft" ? (
        <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          This order is a draft. It must be approved before any stock can be received against it.
        </p>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <dl className="divide-y divide-neutral-100 dark:divide-neutral-800">
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">Expected</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">{order.expected_date || "—"}</dd>
          </div>
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">Raised by</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">
              {[raisedBy?.first_name, raisedBy?.last_name].filter(Boolean).join(" ") || "—"}
            </dd>
          </div>
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">Approved by</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">
              {[approvedBy?.first_name, approvedBy?.last_name].filter(Boolean).join(" ") || "Not yet approved"}
            </dd>
          </div>
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">Notes</dt>
            <dd className="whitespace-pre-line text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">
              {order.notes || "—"}
            </dd>
          </div>
        </dl>
      </div>

      <div>
        <h2 className="font-semibold">Items</h2>
        <div className="mt-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase text-neutral-500 dark:border-neutral-800">
                <tr>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 text-right font-medium">Ordered</th>
                  <th className="px-4 py-3 text-right font-medium">Received</th>
                  <th className="px-4 py-3 text-right font-medium">Unit cost</th>
                  <th className="px-4 py-3 text-right font-medium">Line total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {rows.map((item) => {
                  const ordered = Number(item.quantity_ordered);
                  const received = Number(item.quantity_received);
                  const complete = received >= ordered;
                  return (
                    <tr key={item.id}>
                      <td className="px-4 py-3 font-medium">{itemLabel(item)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatQuantity(ordered)}</td>
                      <td
                        className={`px-4 py-3 text-right tabular-nums ${
                          complete ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"
                        }`}
                      >
                        {formatQuantity(received)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{Number(item.unit_cost).toFixed(2)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{(ordered * Number(item.unit_cost)).toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t border-neutral-200 dark:border-neutral-800">
                <tr>
                  <td colSpan={4} className="px-4 py-3 text-right text-sm font-medium">
                    Order total
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">
                    {currencyCode} {total.toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
