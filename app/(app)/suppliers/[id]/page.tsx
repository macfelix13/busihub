import Link from "next/link";
import { notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { StatusToggleButton } from "../../products/status-toggle-button";
import { setSupplierStatus } from "../actions";
import { purchaseOrderStatusLabel } from "@/lib/validation/purchasing";

export const metadata = { title: "Supplier" };

export default async function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canManage, canCreateOrder] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.SUPPLIERS_MANAGE),
    hasPermission(supabase, businessId, PERMISSIONS.PURCHASE_ORDERS_CREATE),
  ]);

  // RLS-scoped: another tenant's supplier id simply isn't found.
  const { data: supplier, error } = await supabase
    .from("suppliers")
    .select("id, name, contact_name, phone, email, address, payment_terms, notes, status")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("SupplierDetailPage: query failed", error);
  }

  if (!supplier) {
    notFound();
  }

  const { data: orders, error: ordersError } = await supabase
    .from("purchase_orders")
    .select("id, reference, status, expected_date, created_at")
    .eq("supplier_id", id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (ordersError) {
    console.error("SupplierDetailPage: orders query failed", ordersError);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{supplier.name}</h1>
            {supplier.status === "archived" ? (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                Archived
              </span>
            ) : null}
          </div>
          <p className="text-neutral-500">{supplier.contact_name || "No contact person set"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canCreateOrder && supplier.status === "active" ? (
            <Link href={`/purchase-orders/new?supplier=${supplier.id}`}>
              <Button>New order</Button>
            </Link>
          ) : null}
          {canManage ? (
            <>
              <Link href={`/suppliers/${supplier.id}/edit`}>
                <Button variant="secondary">Edit</Button>
              </Link>
              <StatusToggleButton
                action={setSupplierStatus.bind(null, supplier.id, supplier.status === "active" ? "archived" : "active")}
                label={supplier.status === "active" ? "Archive" : "Restore"}
                pendingLabel="Saving…"
                variant={supplier.status === "active" ? "danger" : "secondary"}
              />
            </>
          ) : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <dl className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {[
            ["Phone", supplier.phone],
            ["Email", supplier.email],
            ["Address", supplier.address],
            ["Payment terms", supplier.payment_terms],
            ["Notes", supplier.notes],
          ].map(([label, value]) => (
            <div key={label as string} className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
              <dt className="text-sm font-medium text-neutral-500">{label}</dt>
              <dd className="whitespace-pre-line text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">
                {(value as string) || "—"}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div>
        <h2 className="font-semibold">Purchase orders</h2>
        <div className="mt-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {orders && orders.length > 0 ? (
              orders.map((order) => (
                <li key={order.id}>
                  <Link
                    href={`/purchase-orders/${order.id}`}
                    className="flex items-center justify-between px-5 py-3.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                  >
                    <span className="font-medium">{order.reference}</span>
                    <span className="text-neutral-500">{purchaseOrderStatusLabel(order.status)}</span>
                  </Link>
                </li>
              ))
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500">No orders for this supplier yet.</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
