import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { PurchaseOrderForm, type VariantChoice } from "../purchase-order-form";

export const metadata = { title: "New purchase order" };

interface RawVariant {
  id: string;
  sku: string | null;
  variant_options: Record<string, string> | null;
  cost_price: number | string;
  products: { name: string } | null;
}

export default async function NewPurchaseOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ supplier?: string }>;
}) {
  const { supplier } = await searchParams;

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  // Cosmetic — createPurchaseOrder() re-checks this server-side regardless.
  if (!(await hasPermission(supabase, businessId, PERMISSIONS.PURCHASE_ORDERS_CREATE))) {
    redirect("/purchase-orders");
  }

  const [
    { data: suppliers, error: suppliersError },
    { data: branches, error: branchesError },
    { data: variants, error: variantsError },
    { data: business },
  ] = await Promise.all([
    supabase.from("suppliers").select("id, name").eq("status", "active").order("name"),
    supabase.from("branches").select("id, name, is_main").eq("status", "active").order("is_main", { ascending: false }).order("name"),
    supabase
      .from("product_variants")
      .select("id, sku, variant_options, cost_price, products!inner(name, status)")
      .eq("status", "active")
      .eq("products.status", "active"),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
  ]);

  if (suppliersError) console.error("NewPurchaseOrderPage: suppliers query failed", suppliersError);
  if (branchesError) console.error("NewPurchaseOrderPage: branches query failed", branchesError);
  if (variantsError) console.error("NewPurchaseOrderPage: variants query failed", variantsError);

  const variantChoices: VariantChoice[] = ((variants ?? []) as unknown as RawVariant[])
    .map((v) => {
      const name = v.products?.name ?? "Unknown product";
      const options = Object.entries(v.variant_options ?? {});
      const base = options.length > 0 ? `${name} — ${options.map(([, val]) => val).join(" / ")}` : name;
      return {
        id: v.id,
        label: v.sku ? `${base} (${v.sku})` : base,
        // numeric(14,2) arrives from PostgREST as a string, not a number.
        costPrice: Number(v.cost_price),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">New purchase order</h1>
        <p className="text-neutral-500">Order stock from a supplier.</p>
      </div>
      <PurchaseOrderForm
        suppliers={suppliers ?? []}
        branches={branches ?? []}
        variants={variantChoices}
        defaultSupplierId={supplier}
        currencyCode={business?.currency_code ?? "GHS"}
      />
    </div>
  );
}
