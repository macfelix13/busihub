import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { BranchForm } from "../../branch-form";
import { updateBranch } from "../../actions";

export const metadata = { title: "Edit branch" };

export default async function EditBranchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.BRANCHES_MANAGE);

  // Cosmetic — updateBranch() re-checks this server-side regardless.
  if (!canManage) {
    redirect("/branches");
  }

  // RLS-scoped: a branch id from another tenant simply won't be found here.
  const { data: branch, error } = await supabase
    .from("branches")
    .select("id, name, address_line1, address_line2, city, region, phone, email, timezone, status")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("EditBranchPage: branch query failed", error);
  }

  if (!branch) {
    notFound();
  }

  const boundUpdateBranch = updateBranch.bind(null, branch.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Edit branch</h1>
        <p className="text-neutral-500">{branch.name}</p>
      </div>
      <BranchForm
        action={boundUpdateBranch}
        submitLabel="Save changes"
        pendingLabel="Saving…"
        showStatus
        defaultValues={{
          name: branch.name,
          addressLine1: branch.address_line1 ?? "",
          addressLine2: branch.address_line2 ?? "",
          city: branch.city ?? "",
          region: branch.region ?? "",
          phone: branch.phone ?? "",
          email: branch.email ?? "",
          timezone: branch.timezone,
          status: branch.status,
        }}
      />
    </div>
  );
}

