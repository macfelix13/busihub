import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { ProductDetailsForm, type ProductDetailsFormCategory } from "../../product-details-form";
import { updateProductDetails } from "../../actions";

export const metadata = { title: "Edit product" };

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canEdit = await hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_EDIT);

  // Cosmetic — updateProductDetails() re-checks this server-side regardless.
  if (!canEdit) {
    redirect(`/products/${id}`);
  }

  // RLS-scoped: a product id from another tenant simply won't be found here.
  const [{ data: product, error }, { data: categoryRows, error: categoriesError }] = await Promise.all([
    supabase
      .from("products")
      .select("id, name, description, category_id, unit_of_measure, tax_category, type, duration_minutes")
      .eq("id", id)
      .maybeSingle(),
    supabase.from("categories").select("id, name").eq("status", "active").order("name"),
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
  const categories = (categoryRows ?? []) as ProductDetailsFormCategory[];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{product.type === "service" ? "Edit service" : "Edit product"}</h1>
        <p className="text-neutral-500">{product.name}</p>
      </div>
      <ProductDetailsForm
        action={boundUpdateProductDetails}
        categories={categories}
        productType={product.type as "product" | "service"}
        defaultValues={{
          name: product.name,
          description: product.description ?? "",
          categoryId: product.category_id ?? "",
          unitOfMeasure: product.unit_of_measure,
          taxCategory: product.tax_category as "standard" | "zero_rated" | "exempt",
          durationMinutes: product.duration_minutes ?? undefined,
        }}
      />
    </div>
  );
}