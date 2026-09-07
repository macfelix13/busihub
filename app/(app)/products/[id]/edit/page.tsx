import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { PageHeader } from "@/components/ui/page-header";
import { signProductPhotoUrl } from "@/lib/storage/product-photos";
import { ProductDetailsForm, type ProductDetailsFormCategory } from "../../product-details-form";
import { updateProductDetails, removeProductPhoto } from "../../actions";

export const metadata = { title: "Edit product" };

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const [canEdit, canCreateCategory] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_EDIT),
    // Reusing an existing category from this form only needs products.edit
    // (checked above); typing a brand-new one additionally needs
    // products.create — see resolveCategoryId's own comment in actions.ts.
    // Cosmetic here too: updateProductDetails() re-checks this itself.
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CREATE),
  ]);

  // Cosmetic — updateProductDetails() re-checks this server-side regardless.
  if (!canEdit) {
    redirect(`/products/${id}`);
  }

  // RLS-scoped: a product id from another tenant simply won't be found
  // here. categories(name) is embedded (not just category_id) so the
  // combobox can prefill the CURRENT category's name even if that
  // category has since been archived — an embed follows the row
  // regardless of its status, unlike the separate "active categories for
  // the suggestion list" query below.
  const [{ data: product, error }, { data: categoryRows, error: categoriesError }] = await Promise.all([
    supabase
      .from("products")
      .select("id, name, description, category_id, categories(name), unit_of_measure, tax_category, type, duration_minutes, photo_url")
      .eq("id", id)
      .maybeSingle(),
    supabase.from("categories").select("id, name, icon").eq("status", "active").order("name"),
  ]);

  if (error) {
    console.error("EditProductPage: product query failed", error);
  }
  if (categoriesError) {
    console.error("EditProductPage: categories query failed", categoriesError);
  }

  if (!product) {
    notFound();
  }

  const boundUpdateProductDetails = updateProductDetails.bind(null, product.id);
  const boundRemovePhoto = removeProductPhoto.bind(null, product.id);
  const categories = (categoryRows ?? []) as ProductDetailsFormCategory[];
  const photoUrl = await signProductPhotoUrl(supabase, product.photo_url);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={product.type === "service" ? "Edit service" : "Edit product"} description={product.name} />
      <ProductDetailsForm
        action={boundUpdateProductDetails}
        categories={categories}
        canCreateCategory={canCreateCategory}
        productType={product.type as "product" | "service"}
        photoUrl={photoUrl}
        onRemovePhoto={boundRemovePhoto}
        defaultValues={{
          name: product.name,
          description: product.description ?? "",
          categoryName: (product.categories as unknown as { name: string } | null)?.name ?? "",
          unitOfMeasure: product.unit_of_measure,
          taxCategory: product.tax_category as "standard" | "zero_rated" | "exempt",
          durationMinutes: product.duration_minutes ?? undefined,
        }}
      />
    </div>
  );
}