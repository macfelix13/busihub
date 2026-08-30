import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { SupplierForm } from "../../supplier-form";
import { updateSupplier } from "../../actions";

export const metadata = { title: "Edit supplier" };

export default async function EditSupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  // Cosmetic — updateSupplier() re-checks this server-side regardless.
  if (!(await hasPermission(supabase, businessId, PERMISSIONS.SUPPLIERS_MANAGE))) {
    redirect(`/suppliers/${id}`);
  }

  const { data: supplier, error } = await supabase
    .from("suppliers")
    .select("id, name, contact_name, phone, email, address, payment_terms, notes")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("EditSupplierPage: query failed", error);
  }

  if (!supplier) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Edit supplier</h1>
        <p className="text-neutral-500">{supplier.name}</p>
      </div>
      <SupplierForm
        action={updateSupplier.bind(null, supplier.id)}
        defaultValues={{
          name: supplier.name,
          contactName: supplier.contact_name ?? "",
          phone: supplier.phone ?? "",
          email: supplier.email ?? "",
          address: supplier.address ?? "",
          paymentTerms: supplier.payment_terms ?? "",
          notes: supplier.notes ?? "",
        }}
        submitLabel="Save changes"
        pendingLabel="Saving…"
      />
    </div>
  );
}
