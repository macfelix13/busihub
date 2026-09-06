import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { categoryIconComponent } from "@/lib/ui/category-icons";

export const metadata = { title: "Products" };

const PAGE_SIZE = 50;

interface ProductRow {
  id: string;
  name: string;
  category_id: string | null;
  categories: { name: string; icon: string | null } | null;
  status: "active" | "archived";
  has_variants: boolean;
  type: "product" | "service";
  duration_minutes: number | null;
  available_at_till: boolean;
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
  searchParams: Promise<{
    q?: string;
    status?: string;
    category?: string;
    type?: string;
    minPrice?: string;
    maxPrice?: string;
    page?: string;
  }>;
}) {
  const { q, status, category, type, minPrice, maxPrice, page } = await searchParams;
  const activeStatus = status === "archived" ? "archived" : "active";
  const activeCategory = category && category.trim().length > 0 ? category.trim() : null;
  const activeType = type === "product" || type === "service" ? type : "all";
  const minPriceNumber = minPrice && Number.isFinite(Number(minPrice)) ? Number(minPrice) : null;
  const maxPriceNumber = maxPrice && Number.isFinite(Number(maxPrice)) ? Number(maxPrice) : null;
  const pageNumber = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const [canCreate, { data: business }, { data: categoryRows, error: categoriesError }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CREATE),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
    supabase.from("categories").select("id, name").eq("status", "active").order("name"),
  ]);
  const currencyCode = business?.currency_code ?? "GHS";

  if (categoriesError) {
    console.error("ProductsPage: categories query failed", categoriesError);
  }

  const categories = (categoryRows ?? []) as { id: string; name: string }[];

  // RLS-scoped — no explicit .eq("business_id", ...) needed (Section 4, Section 49).
  //
  // A shop with a large catalogue was shipping every active product over
  // the network on every visit to this page — fine for a few dozen SKUs,
  // a real and growing cost for a few thousand. Paginated the same way
  // sales/expenses already are: a bounded page of rows plus a separate
  // exact count, not "fetch everything and slice it in JavaScript".
  //
  // The variant embed switches from a plain select to `!inner` only when
  // a price filter is active — plain embeds still show every variant for
  // display; `!inner` turns the embed into a join filter, which is
  // exactly what's needed to restrict parent rows to ones with a
  // matching-priced variant, but would otherwise hide a product that
  // happens to have zero variants (never actually possible here, but not
  // a chance worth taking when display doesn't need it).
  const hasPriceFilter = minPriceNumber !== null || maxPriceNumber !== null;
  const variantEmbed = hasPriceFilter ? "product_variants!inner(selling_price)" : "product_variants(selling_price)";

  let query = supabase
    .from("products")
    .select(`id, name, category_id, categories(name, icon), status, has_variants, type, duration_minutes, available_at_till, ${variantEmbed}`, {
      count: "exact",
    })
    .eq("status", activeStatus)
    .order("name", { ascending: true })
    .range((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE - 1);

  if (q && q.trim().length > 0) {
    query = query.ilike("name", `%${q.trim()}%`);
  }

  if (activeCategory) {
    query = query.eq("category_id", activeCategory);
  }

  if (activeType !== "all") {
    query = query.eq("type", activeType);
  }

  if (minPriceNumber !== null) {
    query = query.gte("product_variants.selling_price", minPriceNumber);
  }
  if (maxPriceNumber !== null) {
    query = query.lte("product_variants.selling_price", maxPriceNumber);
  }

  const { data: products, error, count } = await query;

  if (error) {
    console.error("ProductsPage: products query failed", error);
  }

  const totalCount = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const baseFilters = {
    ...(q ? { q } : {}),
    ...(activeStatus === "archived" ? { status: "archived" } : {}),
    ...(activeCategory ? { category: activeCategory } : {}),
    ...(activeType !== "all" ? { type: activeType } : {}),
    ...(minPrice ? { minPrice } : {}),
    ...(maxPrice ? { maxPrice } : {}),
  };
  // Without status/type, so the two helpers below can each add back
  // exactly the one key they're switching, rather than ever setting a
  // query object's key to `undefined` (which next/link would render as
  // the literal string "undefined" in the URL, not omit).
  const filtersWithoutStatusAndType = {
    ...(q ? { q } : {}),
    ...(activeCategory ? { category: activeCategory } : {}),
    ...(minPrice ? { minPrice } : {}),
    ...(maxPrice ? { maxPrice } : {}),
  };
  const pageQuery = (overrides: Record<string, string>) => ({ ...baseFilters, ...overrides });
  const statusQuery = (s: "active" | "archived") => ({
    ...filtersWithoutStatusAndType,
    ...(activeType !== "all" ? { type: activeType } : {}),
    ...(s === "archived" ? { status: "archived" } : {}),
  });
  const typeQuery = (t: "all" | "product" | "service") => ({
    ...filtersWithoutStatusAndType,
    ...(activeStatus === "archived" ? { status: "archived" } : {}),
    ...(t !== "all" ? { type: t } : {}),
  });

  const noun = activeType === "service" ? "services" : activeType === "product" ? "products" : "products or services";
  const isEmpty = !products || products.length === 0;
  const isFiltered = Boolean(q || activeCategory || minPrice || maxPrice);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{activeType === "service" ? "Services" : "Products"}</h1>
          <p className="text-neutral-500">
            {activeType === "service"
              ? "Manage the services you offer through the POS."
              : "Your catalog of sellable items and services."}
          </p>
        </div>
        {canCreate ? (
          <div className="flex gap-2">
            <Link href="/products/new">
              <Button>Add product</Button>
            </Link>
            <Link href="/products/new?type=service">
              <Button variant="secondary">Add service</Button>
            </Link>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
            <Link
              href={{ pathname: "/products", query: statusQuery("active") }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                activeStatus === "active" ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
              }`}
            >
              Active
            </Link>
            <Link
              href={{ pathname: "/products", query: statusQuery("archived") }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                activeStatus === "archived" ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
              }`}
            >
              Archived
            </Link>
          </div>
          <div className="flex gap-1 rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
            <Link
              href={{ pathname: "/products", query: typeQuery("all") }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                activeType === "all" ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
              }`}
            >
              All
            </Link>
            <Link
              href={{ pathname: "/products", query: typeQuery("product") }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                activeType === "product" ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
              }`}
            >
              Products
            </Link>
            <Link
              href={{ pathname: "/products", query: typeQuery("service") }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                activeType === "service" ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
              }`}
            >
              Services
            </Link>
          </div>
        </div>
        <form className="flex flex-wrap items-center gap-2" action="/products">
          {activeStatus === "archived" ? <input type="hidden" name="status" value="archived" /> : null}
          {activeType !== "all" ? <input type="hidden" name="type" value={activeType} /> : null}
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by name…"
            className="min-h-[44px] w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white sm:w-48"
          />
          <select
            name="category"
            defaultValue={activeCategory ?? ""}
            className="min-h-[44px] rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            name="minPrice"
            min={0}
            step="0.01"
            defaultValue={minPrice ?? ""}
            placeholder="Min price"
            aria-label="Minimum price"
            className="min-h-[44px] w-28 rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white"
          />
          <input
            type="number"
            name="maxPrice"
            min={0}
            step="0.01"
            defaultValue={maxPrice ?? ""}
            placeholder="Max price"
            aria-label="Maximum price"
            className="min-h-[44px] w-28 rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
          {isFiltered ? (
            <Link href={{ pathname: "/products", query: activeType !== "all" ? { type: activeType } : {} }}>
              <Button type="button" variant="ghost">
                Clear
              </Button>
            </Link>
          ) : null}
        </form>
      </div>

      {!error ? (
        <p className="text-sm text-neutral-500">
          {totalCount} {noun === "products or services" ? "item" : noun.slice(0, -1)}
          {totalCount === 1 ? "" : "s"}
        </p>
      ) : null}

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load products. Please refresh the page. If this keeps happening, contact support.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {!isEmpty ? (
              (products as unknown as ProductRow[]).map((product) => {
                const Icon = categoryIconComponent(product.categories?.icon ?? null);
                return (
                  <li key={product.id}>
                    <Link
                      href={`/products/${product.id}`}
                      className="flex flex-col gap-1 px-5 py-4 hover:bg-neutral-50 sm:flex-row sm:items-center sm:justify-between dark:hover:bg-neutral-800/50"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{product.name}</span>
                          {product.type === "service" ? (
                            <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                              Service
                            </span>
                          ) : null}
                          {product.status === "archived" ? (
                            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                              Archived
                            </span>
                          ) : null}
                          {product.has_variants ? (
                            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                              {product.product_variants.length} variants
                            </span>
                          ) : null}
                          {!product.available_at_till ? (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                              Hidden from till
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 flex items-center gap-1 text-sm text-neutral-500">
                          {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                          {product.categories?.name ?? "Uncategorized"}
                          {product.type === "service" && product.duration_minutes ? ` · ${product.duration_minutes} min` : ""}
                        </p>
                      </div>
                      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                        {priceRangeLabel(product.product_variants, currencyCode)}
                      </p>
                    </Link>
                  </li>
                );
              })
            ) : (
              <li className="flex flex-col items-center gap-3 px-5 py-10 text-center">
                {activeStatus === "archived" ? (
                  <p className="text-sm text-neutral-500">No archived items.</p>
                ) : isFiltered ? (
                  <p className="text-sm text-neutral-500">Nothing matches those filters.</p>
                ) : activeType === "service" ? (
                  <>
                    <p className="text-sm text-neutral-500">
                      No services yet. Add your first service to start offering services through the POS.
                    </p>
                    {canCreate ? (
                      <Link href="/products/new?type=service">
                        <Button>Add Service</Button>
                      </Link>
                    ) : null}
                  </>
                ) : (
                  <>
                    <p className="text-sm text-neutral-500">
                      {activeType === "product" ? "No products yet." : "No products or services yet."}
                    </p>
                    {canCreate ? (
                      <Link href="/products/new">
                        <Button>Add Product</Button>
                      </Link>
                    ) : null}
                  </>
                )}
              </li>
            )}
          </ul>
        </div>
      )}

      {totalCount > PAGE_SIZE ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-neutral-500">
            Page {pageNumber} of {lastPage} · {totalCount} {noun}
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