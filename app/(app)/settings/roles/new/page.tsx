import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { PageHeader } from "@/components/ui/page-header";
import { RoleDetailsForm } from "../role-details-form";
import { createRole } from "../actions";

export const metadata = { title: "New role" };

export default async function NewRolePage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManageRoles = await hasPermission(supabase, businessId, PERMISSIONS.ROLES_MANAGE);

  // Cosmetic — createRole() re-checks this server-side regardless.
  if (!canManageRoles) {
    redirect("/settings/roles");
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="New role" description="You'll choose its permissions on the next screen, once it's created." />
      <RoleDetailsForm action={createRole} submitLabel="Create role" />
    </div>
  );
}