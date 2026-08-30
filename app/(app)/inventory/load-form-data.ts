import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { VariantOption } from "./stock-form";

interface RawVariant {
  id: string;
  sku: string | null;
  variant_options: Record<string, string> | null;
  products: { name: string; unit_of_measure: string } | null;
}

export function variantOptionLabel(variant: RawVariant): string {
  const name = variant.products?.name ?? "Unknown product";
  const options = Object.entries(variant.variant_options ?? {});
  const base = options.length > 0 ? `${name} — ${options.map(([, v]) => v).join(" / ")}` : name;
  return variant.sku ? `${base} (${variant.sku})` : base;
}

export interface StockFormData {
  branch: { id: string; name: string } | null;
  variants: VariantOption[];
  quantities: Record<string, number>;
}

/**
 * Shared loader for the three stock-entry pages (receive/adjust/count):
 * resolves which branch is being worked on, lists the sellable variants,
 * and reads the current level of each at that branch.
 *
 * Every query is RLS-scoped, so an unauthorized or cross-tenant branch id
 * resolves to null here rather than leaking anything — the caller turns
 * that into a notFound()/redirect.
 */
export async function loadStockFormData(requestedBranchId: string | undefined): Promise<StockFormData> {
  const supabase = await createServerSupabaseClient();

  const { data: branches, error: branchesError } = await supabase
    .from("branches")
    .select("id, name, is_main")
    .eq("status", "active")
    .order("is_main", { ascending: false })
    .order("name", { ascending: true });

  if (branchesError) {
    console.error("loadStockFormData: branches query failed", branchesError);
  }

  const branch =
    branches?.find((b) => b.id === requestedBranchId) ?? branches?.[0] ?? null;

  if (!branch) {
    return { branch: null, variants: [], quantities: {} };
  }

  const [{ data: variants, error: variantsError }, { data: levels, error: levelsError }] = await Promise.all([
    supabase
      .from("product_variants")
      .select("id, sku, variant_options, products!inner(name, unit_of_measure, status)")
      .eq("status", "active")
      .eq("products.status", "active"),
    supabase.from("stock_levels").select("variant_id, quantity").eq("branch_id", branch.id),
  ]);

  if (variantsError) console.error("loadStockFormData: variants query failed", variantsError);
  if (levelsError) console.error("loadStockFormData: stock levels query failed", levelsError);

  const options: VariantOption[] = ((variants ?? []) as unknown as RawVariant[])
    .map((v) => ({
      id: v.id,
      label: variantOptionLabel(v),
      unit: v.products?.unit_of_measure ?? "each",
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const quantities: Record<string, number> = {};
  for (const level of levels ?? []) {
    const row = level as { variant_id: string; quantity: number | string };
    // numeric(14,3) arrives from PostgREST as a string, not a number.
    quantities[row.variant_id] = Number(row.quantity);
  }

  return { branch: { id: branch.id, name: branch.name }, variants: options, quantities };
}
