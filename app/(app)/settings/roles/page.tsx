import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata = { title: "Roles" };

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  is_system_role: boolean;
}

export default async function RolesPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManageRoles = await hasPermission(supabase, businessId, PERMISSIONS.ROLES_MANAGE);

  // Cosmetic — every Server Action underneath re-checks this (Section 49).
  if (!canManageRoles) {
    redirect("/settings/staff");
  }

  const [{ data: roleRows, error: rolesError }, { data: permRows, error: permError }, { data: assignmentRows, error: assignError }] =
    await Promise.all([
      supabase
        .from("roles")
        .select("id, name, description, is_system_role")
        .order("is_system_role", { ascending: false })
        .order("name"),
      // No role_id filter — RLS (role_permissions_select) already scopes
      // this to roles belonging to the caller's own business.
      supabase.from("role_permissions").select("role_id"),
      supabase.from("user_branch_roles").select("role_id, user_id"),
    ]);

  if (rolesError || permError || assignError) {
    console.error("RolesPage: query failed", { rolesError, permError, assignError });
  }

  const roles = (roleRows ?? []) as RoleRow[];

  const permissionCountByRole = new Map<string, number>();
  for (const row of (permRows ?? []) as { role_id: string }[]) {
    permissionCountByRole.set(row.role_id, (permissionCountByRole.get(row.role_id) ?? 0) + 1);
  }

  const staffByRole = new Map<string, Set<string>>();
  for (const row of (assignmentRows ?? []) as { role_id: string; user_id: string }[]) {
    const set = staffByRole.get(row.role_id) ?? new Set<string>();
    set.add(row.user_id);
    staffByRole.set(row.role_id, set);
  }

  const hasError = Boolean(rolesError || permError || assignError);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Roles"
        description="Control exactly what each role can see and do. Built-in roles can have their permissions adjusted, but not their name."
        actions={
          <Link href="/settings/roles/new">
            <Button>New role</Button>
          </Link>
        }
      />

      {hasError ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load roles. Please refresh the page.
        </p>
      ) : roles.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No roles yet" />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-neutral-100 dark:divide-surface-line">
            {roles.map((role) => {
              const staffCount = staffByRole.get(role.id)?.size ?? 0;
              const permissionCount = permissionCountByRole.get(role.id) ?? 0;
              return (
                <li key={role.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{role.name}</span>
                      {role.is_system_role ? <Badge variant="neutral">Built-in</Badge> : <Badge variant="brand">Custom</Badge>}
                    </div>
                    {role.description ? (
                      <p className="text-sm text-neutral-500 dark:text-ink-muted">{role.description}</p>
                    ) : null}
                    <p className="text-sm text-neutral-500 dark:text-ink-muted">
                      {permissionCount} permission{permissionCount === 1 ? "" : "s"} · {staffCount} staff member
                      {staffCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    <Link href={`/settings/roles/${role.id}`}>
                      <Button variant="secondary">Manage</Button>
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}