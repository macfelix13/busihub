import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { ProductForm } from "../product-form";

export const metadata = { title: "Add product" };

export default async function NewProductPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canCreate = await hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CREATE);

  // Cosmetic — createProduct() re-checks this server-side regardless.
  if (!canCreate) {
    redirect("/products");
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Add product</h1>
        <p className="text-neutral-500">New products start active.</p>
      </div>
      <ProductForm />
    </div>
  );
}

