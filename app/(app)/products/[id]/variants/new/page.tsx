import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { VariantForm } from "../../../variant-form";
import { addVariant } from "../../../actions";

export const metadata = { title: "Add variant" };

export default async function NewVariantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canEdit = await hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_EDIT);

  // Cosmetic — addVariant() re-checks this server-side regardless.
  if (!canEdit) {
    redirect(`/products/${id}`);
  }

  const { data: product, error } = await supabase
    .from("products")
    .select("id, name, has_variants, variant_option_names")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("NewVariantPage: product query failed", error);
  }

  if (!product) {
    notFound();
  }

  // This phase doesn't support turning a simple product into a variant one
  // after the fact — see supabase/migrations/0013's file header.
  if (!product.has_variants) {
    redirect(`/products/${product.id}`);
  }

  const boundAddVariant = addVariant.bind(null, product.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Add variant</h1>
        <p className="text-neutral-500">{product.name}</p>
      </div>
      <VariantForm
        action={boundAddVariant}
        optionNames={product.variant_option_names as string[]}
        canSetPrice
        submitLabel="Add variant"
        pendingLabel="Adding…"
      />
    </div>
  );
}

