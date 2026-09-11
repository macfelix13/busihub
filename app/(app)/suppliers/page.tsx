import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";

export const metadata = { title: "Suppliers" };

const PAGE_SIZE = 50;

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const { q, status, page } = await searchParams;
  const activeStatus = status === "archived" ? "archived" : "active";
  const pageNumber = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const [canView, canManage] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.SUPPLIERS_VIEW),
    hasPermission(supabase, businessId, PERMISSIONS.SUPPLIERS_MANAGE),
  ]);

  // Cosmetic — RLS returns nothing anyway, but an empty table reads as
  // "you have no suppliers", which is a different and misleading message.
  if (!canView) {
    redirect("/dashboard");
  }

  // Paginated for the same reason products/sales/expenses are: an
  // established shop's full supplier list, fetched unbounded on every
  // visit, is exactly the kind of payload that is invisible in testing
  // and slow on a real phone once it grows.
  let query = supabase
    .from("suppliers")
    .select("id, name, contact_name, phone, email, payment_terms, status", { count: "exact" })
    .eq("status", activeStatus)
    .order("name", { ascending: true })
    .range((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE - 1);

  if (q && q.trim().length > 0) {
    query = query.ilike("name", `%${q.trim()}%`);
  }

  const { data: suppliers, error, count } = await query;

  if (error) {
    console.error("SuppliersPage: query failed", error);
  }

  const totalCount = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageQuery = (overrides: Record<string, string>) => ({
    ...(q ? { q } : {}),
    ...(activeStatus === "archived" ? { status: "archived" } : {}),
    ...overrides,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Suppliers</h1>
          <p className="text-neutral-500 dark:text-ink-muted">Businesses you buy stock from.</p>
        </div>
        {canManage ? (
          <Link href="/suppliers/new">
            <Button>Add supplier</Button>
          </Link>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          options={[
            {
              key: "active",
              label: "Active",
              active: activeStatus === "active",
              href: { pathname: "/suppliers", query: { ...(q ? { q } : {}) } },
            },
            {
              key: "archived",
              label: "Archived",
              active: activeStatus === "archived",
              href: { pathname: "/suppliers", query: { status: "archived", ...(q ? { q } : {}) } },
            },
          ]}
        />
        <form className="flex flex-wrap gap-2" action="/suppliers">
          {activeStatus === "archived" ? <input type="hidden" name="status" value="archived" /> : null}
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by name…"
            className="min-h-[44px] w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 focus:border-lime-500 focus:outline-none focus:ring-2 focus:ring-lime-400/40 dark:border-surface-line dark:bg-surface dark:text-ink sm:w-56"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load suppliers. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-surface-line dark:bg-surface-card">
          <ul className="divide-y divide-neutral-100 dark:divide-surface-line">
            {suppliers && suppliers.length > 0 ? (
              suppliers.map((supplier) => (
                <li key={supplier.id}>
                  <Link
                    href={`/suppliers/${supplier.id}`}
                    className="flex flex-col gap-1 px-5 py-4 hover:bg-neutral-50 sm:flex-row sm:items-center sm:justify-between dark:hover:bg-surface/60"
                  >
                    <div>
                      <span className="font-medium">{supplier.name}</span>
                      <p className="mt-0.5 text-sm text-neutral-500 dark:text-ink-muted">
                        {[supplier.contact_name, supplier.phone].filter(Boolean).join(" · ") || "No contact details"}
                      </p>
                    </div>
                    <p className="text-sm text-neutral-500 dark:text-ink-muted">{supplier.payment_terms || ""}</p>
                  </Link>
                </li>
              ))
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500 dark:text-ink-muted">
                {activeStatus === "archived" ? "No archived suppliers." : "No suppliers yet."}
              </li>
            )}
          </ul>
        </div>
      )}

      {totalCount > PAGE_SIZE ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-neutral-500 dark:text-ink-muted">
            Page {pageNumber} of {lastPage} · {totalCount} suppliers
          </span>
          <div className="flex gap-2">
            {pageNumber > 1 ? (
              <Link href={{ pathname: "/suppliers", query: pageQuery({ page: String(pageNumber - 1) }) }}>
                <Button variant="secondary">Previous</Button>
              </Link>
            ) : null}
            {pageNumber < lastPage ? (
              <Link href={{ pathname: "/suppliers", query: pageQuery({ page: String(pageNumber + 1) }) }}>
                <Button variant="secondary">Next</Button>
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}