import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { ProductForm, type ProductFormBranch } from "../product-form";

export const metadata = { title: "Add product" };

export default async function NewProductPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const { type } = await searchParams;
  const initialType = type === "service" ? "service" : "product";
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const [canCreate, canReceiveStock, { data: branchRows, error: branchesError }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CREATE),
    // Opening stock goes through the inventory ledger, so it needs
    // inventory.receive. Someone without it is not shown boxes they
    // cannot use — create_product would refuse them anyway.
    hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_RECEIVE),
    supabase
      .from("branches")
      .select("id, name, is_main")
      .eq("status", "active")
      .order("is_main", { ascending: false })
      .order("name", { ascending: true }),
  ]);

  // Cosmetic — createProduct() re-checks this server-side regardless.
  if (!canCreate) {
    redirect("/products");
  }

  if (branchesError) {
    console.error("NewProductPage: branches query failed", branchesError);
  }

  const branches = (branchRows ?? []) as unknown as ProductFormBranch[];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{initialType === "service" ? "Add service" : "Add product"}</h1>
        <p className="text-neutral-500">
          {initialType === "service"
            ? "New services start active. You can switch to “Product” below if you picked the wrong tab."
            : "New products start active. If the goods are already on your shelf, put the quantity in and it is recorded as stock received today."}
        </p>
      </div>
      <ProductForm
        branches={branches}
        canReceiveStock={canReceiveStock && branches.length > 0}
        initialType={initialType}
      />
    </div>
  );
}