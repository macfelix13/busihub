import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { CustomerForm } from "../customer-form";
import { createCustomer } from "../actions";

export const metadata = { title: "Add customer" };

export default async function NewCustomerPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canEdit, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.CUSTOMERS_EDIT),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
  ]);

  // Cosmetic — createCustomer() re-checks this server-side regardless.
  if (!canEdit) {
    redirect("/customers");
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Add customer</h1>
        <p className="text-neutral-500">Someone who buys from you.</p>
      </div>
      <CustomerForm
        action={createCustomer}
        currencyCode={business?.currency_code ?? "GHS"}
        submitLabel="Create customer"
        pendingLabel="Creating…"
      />
    </div>
  );
}
