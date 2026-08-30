import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { formatQuantity } from "@/lib/validation/inventory";

export const metadata = { title: "Inventory" };

interface VariantRow {
  id: string;
  sku: string | null;
  variant_options: Record<string, string>;
  status: "active" | "archived";
  products: {
    id: string;
    name: string;
    unit_of_measure: string;
    status: "active" | "archived";
  } | null;
}

function variantLabel(variant: VariantRow): string {
  const options = Object.entries(variant.variant_options ?? {});
  if (options.length === 0) return variant.products?.name ?? "Unknown product";
  return `${variant.products?.name ?? "Unknown product"} — ${options.map(([, v]) => v).join(" / ")}`;
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; q?: string }>;
}) {
  const { branch, q } = await searchParams;

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canView, canReceive, canAdjust] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_VIEW),
    hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_RECEIVE),
    hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_ADJUST),
  ]);

  // Cosmetic guard — RLS would return nothing anyway, but a bare empty
  // table reads as "you have no stock", which is a different and
  // misleading message (Section 49).
  if (!canView) {
    redirect("/dashboard");
  }

  const { data: branches, error: branchesError } = await supabase
    .from("branches")
    .select("id, name, is_main")
    .eq("status", "active")
    .order("is_main", { ascending: false })
    .order("name", { ascending: true });

  if (branchesError) {
    console.error("InventoryPage: branches query failed", branchesError);
  }

  // Default to the main branch (or the first one) so the page is useful
  // on arrival instead of demanding a selection first.
  const activeBranchId = branches?.some((b) => b.id === branch) ? branch! : branches?.[0]?.id;
  const activeBranch = branches?.find((b) => b.id === activeBranchId);

  // Every active variant in the catalog, LEFT JOINed against this
  // branch's stock rows — a variant with no movements yet has no
  // stock_levels row at all and must still appear, at zero (see the note
  // in migration 0015's header).
  let variantQuery = supabase
    .from("product_variants")
    .select("id, sku, variant_options, status, products!inner(id, name, unit_of_measure, status)")
    .eq("status", "active")
    .eq("products.status", "active");

  if (q && q.trim().length > 0) {
    variantQuery = variantQuery.ilike("products.name", `%${q.trim()}%`);
  }

  const [{ data: variants, error: variantsError }, { data: levels, error: levelsError }] = await Promise.all([
    variantQuery,
    activeBranchId
      ? supabase.from("stock_levels").select("variant_id, quantity").eq("branch_id", activeBranchId)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (variantsError) console.error("InventoryPage: variants query failed", variantsError);
  if (levelsError) console.error("InventoryPage: stock levels query failed", levelsError);

  const quantityByVariant = new Map<string, number>(
    (levels ?? []).map((l) => [
      (l as { variant_id: string }).variant_id,
      // numeric(14,3) arrives from PostgREST as a string, not a number.
      Number((l as { quantity: number | string }).quantity),
    ])
  );

  const rows = ((variants ?? []) as unknown as VariantRow[])
    .map((v) => ({ variant: v, quantity: quantityByVariant.get(v.id) ?? 0 }))
    .sort((a, b) => variantLabel(a.variant).localeCompare(variantLabel(b.variant)));

  const loadFailed = Boolean(variantsError || levelsError || branchesError);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Inventory</h1>
          <p className="text-neutral-500">
            {activeBranch ? `Stock on hand at ${activeBranch.name}.` : "Stock on hand, per branch."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canReceive && activeBranchId ? (
            <Link href={`/inventory/receive?branch=${activeBranchId}`}>
              <Button>Receive stock</Button>
            </Link>
          ) : null}
          {canAdjust && activeBranchId ? (
            <Link href={`/inventory/count?branch=${activeBranchId}`}>
              <Button variant="secondary">Stock count</Button>
            </Link>
          ) : null}
        </div>
      </div>

      {branches && branches.length > 1 ? (
        <div className="flex flex-wrap gap-1 self-start rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
          {branches.map((b) => (
            <Link
              key={b.id}
              href={{ pathname: "/inventory", query: { branch: b.id, ...(q ? { q } : {}) } }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                b.id === activeBranchId ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
              }`}
            >
              {b.name}
            </Link>
          ))}
        </div>
      ) : null}

      <form className="flex flex-wrap gap-2" action="/inventory">
        {activeBranchId ? <input type="hidden" name="branch" value={activeBranchId} /> : null}
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search by product name…"
          className="min-h-[44px] w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white sm:w-72"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      {loadFailed ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load inventory. Please refresh the page.
        </p>
      ) : !activeBranchId ? (
        <p className="rounded-xl border border-neutral-200 px-3.5 py-8 text-center text-sm text-neutral-500 dark:border-neutral-800">
          No active branches yet. Add a branch before tracking stock.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase text-neutral-500 dark:border-neutral-800">
                <tr>
                  <th className="px-4 py-3 font-medium">Item</th>
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 text-right font-medium">On hand</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {rows.length > 0 ? (
                  rows.map(({ variant, quantity }) => (
                    <tr key={variant.id}>
                      <td className="px-4 py-3 font-medium">
                        <Link
                          href={`/inventory/${variant.id}?branch=${activeBranchId}`}
                          className="hover:text-brand-700 dark:hover:text-brand-300"
                        >
                          {variantLabel(variant)}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-neutral-500">{variant.sku || "—"}</td>
                      <td
                        className={`px-4 py-3 text-right font-medium tabular-nums ${
                          quantity <= 0 ? "text-red-600 dark:text-red-400" : ""
                        }`}
                      >
                        {formatQuantity(quantity)}{" "}
                        <span className="text-xs font-normal text-neutral-500">{variant.products?.unit_of_measure}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {canReceive ? (
                            <Link href={`/inventory/receive?branch=${activeBranchId}&variant=${variant.id}`}>
                              <Button variant="ghost">Receive</Button>
                            </Link>
                          ) : null}
                          {canAdjust ? (
                            <Link href={`/inventory/adjust?branch=${activeBranchId}&variant=${variant.id}`}>
                              <Button variant="ghost">Adjust</Button>
                            </Link>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-sm text-neutral-500">
                      {q ? "No products match that search." : "No active products yet. Add a product first."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
