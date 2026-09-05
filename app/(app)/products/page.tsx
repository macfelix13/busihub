import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { formatMoney, toMinorUnits } from "@/lib/money/money";

export const metadata = { title: "Products" };

const PAGE_SIZE = 50;

interface ProductRow {
  id: string;
  name: string;
  category: string | null;
  status: "active" | "archived";
  has_variants: boolean;
  // numeric(14,2) comes back from PostgREST as a string, not a number —
  // see the comment on lib/money/money.ts's toNumber().
  product_variants: { selling_price: number | string }[];
}

function priceRangeLabel(variants: { selling_price: number | string }[], currencyCode: string): string {
  if (variants.length === 0) return "No price set";
  const amounts = variants.map((v) => toMinorUnits(v.selling_price));
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  if (min === max) return formatMoney(min, currencyCode);
  return `${formatMoney(min, currencyCode)} – ${formatMoney(max, currencyCode)}`;
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; category?: string; page?: string }>;
}) {
  const { q, status, category, page } = await searchParams;
  const activeStatus = status === "archived" ? "archived" : "active";
  const activeCategory = category && category.trim().length > 0 ? category.trim() : null;
  const pageNumber = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const [canCreate, { data: business }, { data: categoryRows, error: categoriesError }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CREATE),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
    // Distinct categories currently in use, to populate the filter — no
    // schema change (category stays free text, per this phase's scope),
    // just deduped/sorted client-side since PostgREST has no DISTINCT.
    supabase.from("products").select("category").not("category", "is", null),
  ]);
  const currencyCode = business?.currency_code ?? "GHS";

  if (categoriesError) {
    console.error("ProductsPage: categories query failed", categoriesError);
  }

  const categories = Array.from(
    new Set((categoryRows ?? []).map((r) => (r as { category: string }).category).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  // RLS-scoped — no explicit .eq("business_id", ...) needed (Section 4, Section 49).
  //
  // A shop with a large catalogue was shipping every active product over
  // the network on every visit to this page — fine for a few dozen SKUs,
  // a real and growing cost for a few thousand. Paginated the same way
  // sales/expenses already are: a bounded page of rows plus a separate
  // exact count, not "fetch everything and slice it in JavaScript".
  let query = supabase
    .from("products")
    .select("id, name, category, status, has_variants, product_variants(selling_price)", {
      count: "exact",
    })
    .eq("status", activeStatus)
    .order("name", { ascending: true })
    .range((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE - 1);

  if (q && q.trim().length > 0) {
    query = query.ilike("name", `%${q.trim()}%`);
  }

  if (activeCategory) {
    query = query.eq("category", activeCategory);
  }

  const { data: products, error, count } = await query;

  if (error) {
    console.error("ProductsPage: products query failed", error);
  }

  const totalCount = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageQuery = (overrides: Record<string, string>) => ({
    ...(q ? { q } : {}),
    ...(activeStatus === "archived" ? { status: "archived" } : {}),
    ...(activeCategory ? { category: activeCategory } : {}),
    ...overrides,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Products</h1>
          <p className="text-neutral-500">Your catalog of sellable items.</p>
        </div>
        {canCreate ? (
          <Link href="/products/new">
            <Button>Add product</Button>
          </Link>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1 rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
          <Link
            href={{ pathname: "/products", query: { ...(q ? { q } : {}), ...(activeCategory ? { category: activeCategory } : {}) } }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              activeStatus === "active" ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            Active
          </Link>
          <Link
            href={{
              pathname: "/products",
              query: { status: "archived", ...(q ? { q } : {}), ...(activeCategory ? { category: activeCategory } : {}) },
            }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              activeStatus === "archived" ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            Archived
          </Link>
        </div>
        <form className="flex flex-wrap gap-2" action="/products">
          {activeStatus === "archived" ? <input type="hidden" name="status" value="archived" /> : null}
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by name…"
            className="min-h-[44px] w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white sm:w-56"
          />
          <select
            name="category"
            defaultValue={activeCategory ?? ""}
            className="min-h-[44px] rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load products. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {products && products.length > 0 ? (
              (products as ProductRow[]).map((product) => (
                <li key={product.id}>
                  <Link
                    href={`/products/${product.id}`}
                    className="flex flex-col gap-1 px-5 py-4 hover:bg-neutral-50 sm:flex-row sm:items-center sm:justify-between dark:hover:bg-neutral-800/50"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{product.name}</span>
                        {product.has_variants ? (
                          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                            {product.product_variants.length} variants
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-sm text-neutral-500">{product.category || "Uncategorized"}</p>
                    </div>
                    <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                      {priceRangeLabel(product.product_variants, currencyCode)}
                    </p>
                  </Link>
                </li>
              ))
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500">
                {activeStatus === "archived" ? "No archived products." : "No products yet."}
              </li>
            )}
          </ul>
        </div>
      )}

      {totalCount > PAGE_SIZE ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-neutral-500">
            Page {pageNumber} of {lastPage} · {totalCount} products
          </span>
          <div className="flex gap-2">
            {pageNumber > 1 ? (
              <Link href={{ pathname: "/products", query: pageQuery({ page: String(pageNumber - 1) }) }}>
                <Button variant="secondary">Previous</Button>
              </Link>
            ) : null}
            {pageNumber < lastPage ? (
              <Link href={{ pathname: "/products", query: pageQuery({ page: String(pageNumber + 1) }) }}>
                <Button variant="secondary">Next</Button>
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
