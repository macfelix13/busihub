import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { PageHeader } from "@/components/ui/page-header";
import { CategoryForm } from "../category-form";
import { createCategory } from "../actions";

export const metadata = { title: "Add category" };

export default async function NewCategoryPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canCreate = await hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CREATE);

  // Cosmetic — createCategory() re-checks this server-side regardless.
  if (!canCreate) {
    redirect("/products/categories");
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Add category" description="Available immediately to both products and services." />
      <CategoryForm action={createCategory} submitLabel="Create category" />
    </div>
  );
}