import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { StatusToggleButton } from "@/app/(app)/products/status-toggle-button";
import { deactivateStaffMember, reactivateStaffMember } from "../actions";
import { RoleAssignmentForm } from "./role-assignment-form";

export const metadata = { title: "Staff member" };

type ProfileStatus = "active" | "inactive" | "suspended";

const STATUS_BADGE: Record<ProfileStatus, string> = {
  active: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  inactive: "bg-neutral-100 text-neutral-600 dark:bg-surface dark:text-ink-muted",
  suspended: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

export default async function StaffMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManageUsers = await hasPermission(supabase, businessId, PERMISSIONS.USERS_MANAGE);

  // Cosmetic — every Server Action below re-checks this (Section 49).
  if (!canManageUsers) {
    redirect("/dashboard");
  }

  const {
    data: { user: viewer },
  } = await supabase.auth.getUser();

  const { data: person, error } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, email, phone, status, last_login_at, created_at")
    .eq("id", id)
    .eq("business_id", businessId) // never trust the URL's id alone — scoped to this business explicitly
    .maybeSingle();

  if (error) {
    console.error("StaffMemberPage: profile query failed", error);
  }

  if (!person) {
    notFound();
  }

  const status = person.status as ProfileStatus;
  const isYou = person.id === viewer?.id;

  const [{ data: branchRows, error: branchesError }, { data: roleRows, error: rolesError }, { data: assignments, error: assignmentsError }] =
    await Promise.all([
      supabase.from("branches").select("id, name").eq("business_id", businessId).order("is_main", { ascending: false }).order("name"),
      supabase.from("roles").select("id, name").eq("business_id", businessId).order("name"),
      supabase.from("user_branch_roles").select("branch_id, role_id").eq("user_id", person.id),
      // Whether deactivating this person would leave the business with no
      // active Owner — computed below from a business-wide read, not
      // guessed from this one profile.
    ]);

  if (branchesError || rolesError || assignmentsError) {
    console.error("StaffMemberPage: reference data query failed", { branchesError, rolesError, assignmentsError });
  }

  const branches = (branchRows ?? []) as { id: string; name: string }[];
  const roles = (roleRows ?? []) as { id: string; name: string }[];

  const roleIdByBranch = new Map<string, string>();
  for (const row of (assignments ?? []) as { branch_id: string; role_id: string }[]) {
    roleIdByBranch.set(row.branch_id, row.role_id);
  }

  const { data: ownerHolders, error: ownerHoldersError } = await supabase
    .from("user_branch_roles")
    .select("user_id, roles!inner(name, is_system_role), profiles!inner(status)")
    .eq("business_id", businessId)
    .eq("roles.name", "Owner")
    .eq("roles.is_system_role", true);

  if (ownerHoldersError) {
    console.error("StaffMemberPage: owner-holders query failed", ownerHoldersError);
  }

  const activeOwnerIds = new Set(
    ((ownerHolders ?? []) as unknown as { user_id: string; profiles: { status: ProfileStatus } | null }[])
      .filter((row) => row.profiles?.status === "active")
      .map((row) => row.user_id)
  );
  const isOnlyActiveOwner = activeOwnerIds.has(person.id) && activeOwnerIds.size <= 1;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/settings/staff" className="text-sm text-brand-700 hover:underline dark:text-brand-300">
          ← Staff
        </Link>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{`${person.first_name} ${person.last_name}`.trim()}</h1>
              {isYou ? (
                <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                  You
                </span>
              ) : null}
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status]}`}>
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </span>
            </div>
            <p className="text-neutral-500 dark:text-ink-muted">
              {person.email ?? "No email on record"}
              {person.phone ? ` · ${person.phone}` : ""}
            </p>
          </div>
          {!isYou ? (
            <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
              {status === "active" ? (
                isOnlyActiveOwner ? (
                  <p className="max-w-[16rem] text-right text-sm text-neutral-500 dark:text-ink-muted">
                    Can&apos;t deactivate — this business&apos;s only active Owner. Make someone else Owner first.
                  </p>
                ) : (
                  <StatusToggleButton
                    action={deactivateStaffMember.bind(null, person.id)}
                    label="Deactivate"
                    pendingLabel="Deactivating…"
                    variant="danger"
                  />
                )
              ) : (
                <StatusToggleButton
                  action={reactivateStaffMember.bind(null, person.id)}
                  label="Reactivate"
                  pendingLabel="Reactivating…"
                  variant="secondary"
                />
              )}
            </div>
          ) : null}
        </div>
      </div>

      {status !== "active" ? (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          This account is deactivated — they can&apos;t sign in to Busihub until it&apos;s reactivated.
        </p>
      ) : null}

      {isYou ? (
        <p className="rounded-xl bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:bg-surface/60 dark:text-ink-muted">
          You can&apos;t change your own role or deactivate your own account — ask another admin.
        </p>
      ) : null}

      <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card">
        <h2 className="font-semibold">Role by branch</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
          Most permissions apply business-wide regardless of branch — this mainly matters for till/cashier
          assignments at a specific location.
        </p>
        <div className="mt-4 flex flex-col gap-4">
          {branches.map((branch) =>
            isYou ? (
              <div key={branch.id} className="text-sm">
                <span className="font-medium">{branch.name}: </span>
                <span className="text-neutral-500 dark:text-ink-muted">
                  {roles.find((r) => r.id === roleIdByBranch.get(branch.id))?.name ?? "No access"}
                </span>
              </div>
            ) : (
              <RoleAssignmentForm
                key={branch.id}
                userId={person.id}
                branchId={branch.id}
                branchName={branch.name}
                currentRoleId={roleIdByBranch.get(branch.id) ?? null}
                roles={roles}
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}