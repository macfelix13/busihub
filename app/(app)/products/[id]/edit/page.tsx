import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { ProductDetailsForm } from "../../product-details-form";
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
  const { data: product, error } = await supabase
    .from("products")
    .select("id, name, description, category, unit_of_measure, tax_category")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("EditProductPage: product query failed", error);
  }

  if (!product) {
    notFound();
  }

  const boundUpdateProductDetails = updateProductDetails.bind(null, product.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Edit product</h1>
        <p className="text-neutral-500">{product.name}</p>
      </div>
      <ProductDetailsForm
        action={boundUpdateProductDetails}
        defaultValues={{
          name: product.name,
          description: product.description ?? "",
          category: product.category ?? "",
          unitOfMeasure: product.unit_of_measure,
          taxCategory: product.tax_category as "standard" | "zero_rated" | "exempt",
        }}
      />
    </div>
  );
}

