import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { BranchForm } from "../branch-form";
import { createBranch } from "../actions";

export const metadata = { title: "Add branch" };

export default async function NewBranchPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.BRANCHES_MANAGE);

  // Cosmetic — createBranch() re-checks this server-side regardless.
  if (!canManage) {
    redirect("/branches");
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Add branch</h1>
        <p className="text-neutral-500">New branches start active — deactivate one later from its Edit page if needed.</p>
      </div>
      <BranchForm
        action={createBranch}
        submitLabel="Create branch"
        pendingLabel="Creating…"
        defaultValues={{ timezone: "Africa/Accra" }}
      />
    </div>
  );
}

