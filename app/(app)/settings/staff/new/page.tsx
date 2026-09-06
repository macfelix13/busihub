import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { InviteStaffForm } from "./invite-staff-form";

export const metadata = { title: "Invite staff" };

export default async function InviteStaffPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManageUsers = await hasPermission(supabase, businessId, PERMISSIONS.USERS_MANAGE);

  // Cosmetic — inviteStaff() re-checks this regardless (Section 49).
  if (!canManageUsers) {
    redirect("/dashboard");
  }

  const [{ data: branchRows, error: branchesError }, { data: roleRows, error: rolesError }] = await Promise.all([
    supabase.from("branches").select("id, name").eq("business_id", businessId).order("is_main", { ascending: false }).order("name"),
    supabase.from("roles").select("id, name, description").eq("business_id", businessId).order("name"),
  ]);

  if (branchesError || rolesError) {
    console.error("InviteStaffPage: query failed", { branchesError, rolesError });
  }

  const branches = (branchRows ?? []) as { id: string; name: string }[];
  const roles = (roleRows ?? []) as { id: string; name: string; description: string | null }[];

  if (!branches.length || !roles.length) {
    return (
      <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
        Couldn&apos;t load your branches or roles. Please refresh the page.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/settings/staff" className="text-sm text-brand-700 hover:underline dark:text-brand-300">
          ← Staff
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Invite a colleague</h1>
        <p className="text-neutral-500">They&apos;ll get an email to set their own password and sign in.</p>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <InviteStaffForm branches={branches} roles={roles} />
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="font-semibold">What each role can do</h2>
        <dl className="mt-3 flex flex-col gap-3">
          {roles.map((role) => (
            <div key={role.id} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <dt className="w-32 flex-shrink-0 font-medium">{role.name}</dt>
              <dd className="min-w-0 break-words text-sm text-neutral-500">{role.description ?? "—"}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}