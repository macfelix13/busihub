import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { ProviderForm } from "../provider-form";
import { createServiceProvider } from "../actions";

export const metadata = { title: "Add service provider" };

export default async function NewServiceProviderPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.USERS_MANAGE);

  // Cosmetic — createServiceProvider() re-checks this server-side regardless.
  if (!canManage) {
    redirect("/settings/service-providers");
  }

  const { data: branchRows, error } = await supabase
    .from("branches")
    .select("id, name")
    .eq("status", "active")
    .order("is_main", { ascending: false })
    .order("name");

  if (error) {
    console.error("NewServiceProviderPage: branches query failed", error);
  }

  const branches = (branchRows ?? []) as { id: string; name: string }[];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Add service provider</h1>
        <p className="text-neutral-500">
          A barber, nail tech, or similar staff member who renders a service but doesn&rsquo;t sign in.
        </p>
      </div>
      {branches.length === 0 ? (
        <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Add an active branch first — a service provider must be tied to one.
        </p>
      ) : (
        <ProviderForm action={createServiceProvider} branches={branches} submitLabel="Add service provider" />
      )}
    </div>
  );
}