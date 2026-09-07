import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { PageHeader } from "@/components/ui/page-header";
import { VariantForm } from "../../../../variant-form";
import { updateVariant } from "../../../../actions";

export const metadata = { title: "Edit variant" };

export default async function EditVariantPage({ params }: { params: Promise<{ id: string; variantId: string }> }) {
  const { id, variantId } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const [canEdit, canChangePrice] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_EDIT),
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CHANGE_PRICE),
  ]);

  // Cosmetic — updateVariant() re-checks products.edit server-side
  // regardless, and separately re-checks products.change_price before
  // ever including a price field in the update (Section 49).
  if (!canEdit) {
    redirect(`/products/${id}`);
  }

  // Neither query needs the other's result — both key off the route
  // params alone — so they run together rather than one after the other.
  const [
    { data: product, error: productError },
    { data: variant, error: variantError },
  ] = await Promise.all([
    supabase.from("products").select("id, name, variant_option_names").eq("id", id).maybeSingle(),
    supabase
      .from("product_variants")
      .select("id, sku, barcode, variant_options, cost_price, selling_price")
      .eq("id", variantId)
      .eq("product_id", id)
      .maybeSingle(),
  ]);

  if (productError || !product) {
    console.error("EditVariantPage: product query failed", productError);
    notFound();
  }

  if (variantError) {
    console.error("EditVariantPage: variant query failed", variantError);
  }

  if (!variant) {
    notFound();
  }

  const boundUpdateVariant = updateVariant.bind(null, product.id, variant.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Edit variant" description={`${product.name} · ${variant.sku || "no SKU"}`} />
      <VariantForm
        action={boundUpdateVariant}
        optionNames={product.variant_option_names as string[]}
        canSetPrice={canChangePrice}
        defaultValues={{
          sku: variant.sku ?? "",
          barcode: variant.barcode ?? "",
          variantOptions: variant.variant_options as Record<string, string>,
          costPrice: Number(variant.cost_price),
          sellingPrice: Number(variant.selling_price),
        }}
        submitLabel="Save changes"
        pendingLabel="Saving…"
      />
    </div>
  );
}