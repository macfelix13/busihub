import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatusToggleButton } from "@/app/(app)/products/status-toggle-button";
import { RoleDetailsForm } from "../role-details-form";
import { RolePermissionsForm } from "../role-permissions-form";
import { updateRoleDetails, updateRolePermissions, deleteRole } from "../actions";

export const metadata = { title: "Role" };

export default async function RoleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManageRoles = await hasPermission(supabase, businessId, PERMISSIONS.ROLES_MANAGE);

  // Cosmetic — every Server Action below re-checks this (Section 49).
  if (!canManageRoles) {
    redirect("/settings/roles");
  }

  const [
    { data: role, error: roleError },
    { data: catalogRows, error: catalogError },
    { data: grantRows, error: grantError },
    { data: assignmentRows, error: assignError },
  ] = await Promise.all([
    // business_id filter is belt-and-suspenders beyond RLS (Section 49) —
    // a role id from another tenant simply isn't found here.
    supabase.from("roles").select("id, name, description, is_system_role").eq("id", id).eq("business_id", businessId).maybeSingle(),
    supabase.from("permissions").select("key, category, description").order("category").order("key"),
    supabase.from("role_permissions").select("permission_id, permissions(key)").eq("role_id", id),
    supabase.from("user_branch_roles").select("user_id").eq("role_id", id),
  ]);

  if (roleError || catalogError || grantError || assignError) {
    console.error("RoleDetailPage: query failed", { roleError, catalogError, grantError, assignError });
  }

  if (!role) {
    notFound();
  }

  const catalog = (catalogRows ?? []) as { key: string; category: string; description: string }[];
  const selectedKeys = ((grantRows ?? []) as unknown as { permissions: { key: string } | null }[])
    .map((row) => row.permissions?.key)
    .filter((key): key is string => Boolean(key));

  const staffCount = new Set(((assignmentRows ?? []) as { user_id: string }[]).map((row) => row.user_id)).size;
  const isOwnerRole = role.is_system_role && role.name === "Owner";

  const boundUpdateDetails = updateRoleDetails.bind(null, role.id);
  const boundUpdatePermissions = updateRolePermissions.bind(null, role.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/settings/roles" className="text-sm text-brand-700 hover:underline dark:text-brand-300">
          ← Roles
        </Link>
        <PageHeader
          className="mt-2"
          title={role.name}
          description={`${staffCount} staff member${staffCount === 1 ? "" : "s"} currently hold this role.`}
        />
      </div>

      <Card className="p-5">
        <h2 className="font-semibold">Details</h2>
        <div className="mt-4">
          <RoleDetailsForm
            action={boundUpdateDetails}
            defaultValues={{ name: role.name, description: role.description ?? "" }}
            submitLabel="Save details"
            nameLocked={role.is_system_role}
          />
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold">Permissions</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
          Choose exactly what someone with this role can see and do.
        </p>
        <div className="mt-4">
          <RolePermissionsForm
            action={boundUpdatePermissions}
            catalog={catalog}
            selectedKeys={selectedKeys}
            isOwnerRole={isOwnerRole}
          />
        </div>
      </Card>

      {!role.is_system_role ? (
        <Card className="p-5">
          <h2 className="font-semibold">Delete role</h2>
          {staffCount > 0 ? (
            <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
              Can&apos;t delete — {staffCount} staff member{staffCount === 1 ? "" : "s"} currently hold this role.
              Reassign them first.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">This can&apos;t be undone.</p>
              <div className="mt-4">
                <StatusToggleButton
                  action={deleteRole.bind(null, role.id)}
                  label="Delete role"
                  pendingLabel="Deleting…"
                  variant="danger"
                  confirm={{ title: "Delete this role?", description: "This can't be undone.", confirmLabel: "Delete" }}
                />
              </div>
            </>
          )}
        </Card>
      ) : null}
    </div>
  );
}