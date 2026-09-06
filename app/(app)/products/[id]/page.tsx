import Link from "next/link";
import { notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money/money";
import { formatQuantity } from "@/lib/validation/inventory";
import { setProductStatus, setVariantStatus } from "../actions";
import { StatusToggleButton } from "../status-toggle-button";

export const metadata = { title: "Product" };

function optionsLabel(options: Record<string, string>): string {
  const entries = Object.entries(options);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}: ${value}`).join(", ");
}

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canEdit, canArchive, canChangePrice, canViewStock, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_EDIT),
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_ARCHIVE),
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CHANGE_PRICE),
    hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_VIEW),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
  ]);
  const currencyCode = business?.currency_code ?? "GHS";

  // RLS-scoped: a product id from another tenant simply won't be found here.
  const { data: product, error } = await supabase
    .from("products")
    .select(
      "id, name, description, category, unit_of_measure, tax_category, has_variants, variant_option_names, status, type, product_variants(id, sku, barcode, variant_options, cost_price, selling_price, is_default, status)"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("ProductDetailPage: product query failed", error);
  }

  if (!product) {
    notFound();
  }

  // A service never carries stock (migration 0040), so the whole "In
  // stock" column is meaningless for one — not just empty, but genuinely
  // not applicable — and is hidden rather than shown as "none".
  const showStock = canViewStock && product.type === "product";

  // sku is optional (0014) — a.sku.localeCompare would throw on null, so
  // variants without one sort after every variant that has one, and
  // amongst themselves by nothing in particular (insertion order).
  // Current stock, per variant per branch. Read-only here: changing it is
  // a receive, an adjustment or a count, each of which has its own page
  // and its own reason recorded in the ledger.
  // Asked only when the caller may see stock. RLS would otherwise filter
  // the rows away silently and the column would read "none" for a product
  // that is fully stocked — a wrong answer is worse than no column.
  const variantIds = product.product_variants.map((v: { id: string }) => v.id);
  const { data: stockRows, error: stockError } = showStock && variantIds.length
    ? await supabase
        .from("stock_levels")
        .select("variant_id, quantity, branches(name)")
        .in("variant_id", variantIds)
    : { data: [], error: null };

  if (stockError) {
    console.error("ProductDetailPage: stock query failed", stockError);
  }

  const stockByVariant = new Map<string, { branch: string; quantity: number }[]>();
  for (const row of (stockRows ?? []) as unknown as {
    variant_id: string;
    quantity: number | string;
    branches: { name: string } | null;
  }[]) {
    const list = stockByVariant.get(row.variant_id) ?? [];
    list.push({ branch: row.branches?.name ?? "—", quantity: Number(row.quantity) });
    stockByVariant.set(row.variant_id, list);
  }

  const variants = [...product.product_variants].sort((a, b) => {
    if (a.sku === null && b.sku === null) return 0;
    if (a.sku === null) return 1;
    if (b.sku === null) return -1;
    return a.sku.localeCompare(b.sku);
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{product.name}</h1>
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
          </div>
          <p className="text-neutral-500">
            {product.category || "Uncategorized"} · {product.unit_of_measure}
          </p>
          {product.description ? <p className="mt-2 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">{product.description}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          {canEdit ? (
            <Link href={`/products/${product.id}/edit`}>
              <Button variant="secondary">Edit</Button>
            </Link>
          ) : null}
          {canArchive ? (
            <StatusToggleButton
              action={setProductStatus.bind(null, product.id, product.status === "active" ? "archived" : "active")}
              label={product.status === "active" ? "Archive product" : "Restore product"}
              pendingLabel="Saving…"
              variant={product.status === "active" ? "danger" : "secondary"}
            />
          ) : null}
        </div>
      </div>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">Variants</h2>
          {canEdit && product.has_variants ? (
            <Link href={`/products/${product.id}/variants/new`}>
              <Button variant="secondary">Add variant</Button>
            </Link>
          ) : null}
        </div>

        <div className="mt-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase text-neutral-500 dark:border-neutral-800">
                <tr>
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">Barcode</th>
                  {product.has_variants ? <th className="px-4 py-3 font-medium">Options</th> : null}
                  <th className="px-4 py-3 font-medium">Cost</th>
                  <th className="px-4 py-3 font-medium">Price</th>
                  {showStock ? <th className="px-4 py-3 font-medium">In stock</th> : null}
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {variants.map((variant) => (
                  <tr key={variant.id}>
                    <td className="px-4 py-3 font-medium">{variant.sku || "—"}</td>
                    <td className="px-4 py-3 text-neutral-500">{variant.barcode || "—"}</td>
                    {product.has_variants ? (
                      <td className="px-4 py-3 text-neutral-500">{optionsLabel(variant.variant_options as Record<string, string>)}</td>
                    ) : null}
                    <td className="px-4 py-3">{formatMoneyMinor(variant.cost_price, currencyCode)}</td>
                    <td className="px-4 py-3">{formatMoneyMinor(variant.selling_price, currencyCode)}</td>
                    {showStock ? (
                    <td className="px-4 py-3 tabular-nums">
                      {(stockByVariant.get(variant.id) ?? []).length === 0 ? (
                        <span className="text-neutral-400">none</span>
                      ) : (
                        <span className="flex flex-col">
                          {(stockByVariant.get(variant.id) ?? []).map((level) => (
                            <span key={level.branch}>
                              {formatQuantity(level.quantity)}
                              <span className="ml-1 text-xs text-neutral-500">{level.branch}</span>
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    ) : null}
                    <td className="px-4 py-3">
                      {variant.status === "archived" ? (
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                          Archived
                        </span>
                      ) : (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
                          Active
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {canEdit ? (
                          <Link href={`/products/${product.id}/variants/${variant.id}/edit`}>
                            <Button variant="ghost">Edit</Button>
                          </Link>
                        ) : null}
                        {canArchive ? (
                          <StatusToggleButton
                            action={setVariantStatus.bind(null, product.id, variant.id, variant.status === "active" ? "archived" : "active")}
                            label={variant.status === "active" ? "Archive" : "Restore"}
                            pendingLabel="Saving…"
                            variant="ghost"
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {!canChangePrice ? (
          <p className="mt-2 text-sm text-neutral-500">You can view prices here but don&apos;t have permission to change them.</p>
        ) : null}
      </div>
    </div>
  );
}

/** product_variants.cost_price/selling_price come back from Postgres as decimal strings via PostgREST, not JS numbers — coerce before formatting. */
function formatMoneyMinor(decimalAmount: number | string, currencyCode: string): string {
  const amount = typeof decimalAmount === "string" ? Number(decimalAmount) : decimalAmount;
  return formatMoney(Math.round(amount * 100), currencyCode);
}