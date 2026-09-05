import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { PURCHASE_ORDER_STATUSES, purchaseOrderStatusLabel } from "@/lib/validation/purchasing";

export const metadata = { title: "Purchase orders" };

const PAGE_SIZE = 50;

const STATUS_CLASSES: Record<string, string> = {
  draft: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  approved: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  partially_received: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  received: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  cancelled: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

interface OrderRow {
  id: string;
  reference: string;
  status: string;
  expected_date: string | null;
  created_at: string;
  suppliers: { name: string } | null;
  branches: { name: string } | null;
}

export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const { status, page } = await searchParams;
  const activeStatus = PURCHASE_ORDER_STATUSES.some((s) => s.value === status) ? status! : null;
  const pageNumber = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const [canView, canCreate] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.SUPPLIERS_VIEW),
    hasPermission(supabase, businessId, PERMISSIONS.PURCHASE_ORDERS_CREATE),
  ]);

  if (!canView) {
    redirect("/dashboard");
  }

  // Paginated for the same reason products/suppliers now are: an
  // unbounded "every order this shop has ever raised" query only looks
  // cheap in a fresh database.
  let query = supabase
    .from("purchase_orders")
    .select("id, reference, status, expected_date, created_at, suppliers(name), branches(name)", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .range((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE - 1);

  if (activeStatus) {
    query = query.eq("status", activeStatus);
  }

  const { data: orders, error, count } = await query;

  if (error) {
    console.error("PurchaseOrdersPage: query failed", error);
  }

  const totalCount = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Purchase orders</h1>
          <p className="text-neutral-500">Stock you have ordered from suppliers.</p>
        </div>
        {canCreate ? (
          <Link href="/purchase-orders/new">
            <Button>New order</Button>
          </Link>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1 self-start rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
        <Link
          href="/purchase-orders"
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
            activeStatus === null ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
          }`}
        >
          All
        </Link>
        {PURCHASE_ORDER_STATUSES.map((s) => (
          <Link
            key={s.value}
            href={{ pathname: "/purchase-orders", query: { status: s.value } }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              activeStatus === s.value ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            {s.label}
          </Link>
        ))}
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load purchase orders. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {orders && orders.length > 0 ? (
              (orders as unknown as OrderRow[]).map((order) => (
                <li key={order.id}>
                  <Link
                    href={`/purchase-orders/${order.id}`}
                    className="flex flex-col gap-1 px-5 py-4 hover:bg-neutral-50 sm:flex-row sm:items-center sm:justify-between dark:hover:bg-neutral-800/50"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{order.reference}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            STATUS_CLASSES[order.status] ?? STATUS_CLASSES.draft
                          }`}
                        >
                          {purchaseOrderStatusLabel(order.status)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-sm text-neutral-500">
                        {order.suppliers?.name ?? "Unknown supplier"} · {order.branches?.name ?? "Unknown branch"}
                      </p>
                    </div>
                    <p className="text-sm text-neutral-500">
                      {order.expected_date ? `Expected ${order.expected_date}` : ""}
                    </p>
                  </Link>
                </li>
              ))
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500">
                {activeStatus ? "No orders with this status." : "No purchase orders yet."}
              </li>
            )}
          </ul>
        </div>
      )}

      {totalCount > PAGE_SIZE ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-neutral-500">
            Page {pageNumber} of {lastPage} · {totalCount} orders
          </span>
          <div className="flex gap-2">
            {pageNumber > 1 ? (
              <Link
                href={{
                  pathname: "/purchase-orders",
                  query: { ...(activeStatus ? { status: activeStatus } : {}), page: String(pageNumber - 1) },
                }}
              >
                <Button variant="secondary">Previous</Button>
              </Link>
            ) : null}
            {pageNumber < lastPage ? (
              <Link
                href={{
                  pathname: "/purchase-orders",
                  query: { ...(activeStatus ? { status: activeStatus } : {}), page: String(pageNumber + 1) },
                }}
              >
                <Button variant="secondary">Next</Button>
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}