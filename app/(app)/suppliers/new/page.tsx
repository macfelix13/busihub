import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { SupplierForm } from "../supplier-form";
import { createSupplier } from "../actions";

export const metadata = { title: "Add supplier" };

export default async function NewSupplierPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  // Cosmetic — createSupplier() re-checks this server-side regardless.
  if (!(await hasPermission(supabase, businessId, PERMISSIONS.SUPPLIERS_MANAGE))) {
    redirect("/suppliers");
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Add supplier</h1>
        <p className="text-neutral-500 dark:text-ink-muted">Someone you buy stock from.</p>
      </div>
      <SupplierForm action={createSupplier} submitLabel="Create supplier" pendingLabel="Creating…" />
    </div>
  );
}