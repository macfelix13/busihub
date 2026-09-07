import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { PageHeader } from "@/components/ui/page-header";
import { CategoryForm } from "../../category-form";
import { updateCategory } from "../../actions";

export const metadata = { title: "Edit category" };

export default async function EditCategoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canEdit = await hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_EDIT);

  // Cosmetic — updateCategory() re-checks this server-side regardless.
  if (!canEdit) {
    redirect("/products/categories");
  }

  // RLS-scoped: a category id from another tenant simply won't be found here.
  const { data: category, error } = await supabase
    .from("categories")
    .select("id, name, description, icon")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("EditCategoryPage: category query failed", error);
  }

  if (!category) {
    notFound();
  }

  const boundUpdateCategory = updateCategory.bind(null, category.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Edit category" description={category.name} />
      <CategoryForm
        action={boundUpdateCategory}
        defaultValues={{
          name: category.name,
          description: category.description ?? "",
          icon: category.icon ?? "",
        }}
        submitLabel="Save changes"
      />
    </div>
  );
}