import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { PageHeader } from "@/components/ui/page-header";
import { CustomerForm } from "../../customer-form";
import { updateCustomer } from "../../actions";

export const metadata = { title: "Edit customer" };

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canEdit, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.CUSTOMERS_EDIT),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
  ]);

  // Cosmetic — updateCustomer() re-checks this server-side regardless.
  if (!canEdit) {
    redirect(`/customers/${id}`);
  }

  const { data: customer, error } = await supabase
    .from("customers")
    .select("id, name, phone, email, address, notes, credit_limit")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("EditCustomerPage: query failed", error);
  }

  if (!customer) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Edit customer" description={customer.name} />
      <CustomerForm
        action={updateCustomer.bind(null, customer.id)}
        currencyCode={business?.currency_code ?? "GHS"}
        defaultValues={{
          name: customer.name,
          phone: customer.phone ?? "",
          email: customer.email ?? "",
          address: customer.address ?? "",
          notes: customer.notes ?? "",
          // numeric(14,2) arrives from PostgREST as a string.
          creditLimit: String(customer.credit_limit ?? "0"),
        }}
        submitLabel="Save changes"
        pendingLabel="Saving…"
      />
    </div>
  );
}