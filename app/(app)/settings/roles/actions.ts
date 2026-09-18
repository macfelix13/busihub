"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { roleDetailsSchema, rolePermissionsSchema } from "@/lib/validation/roles";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

type SupabaseServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

async function requireRolesPermission(supabase: SupabaseServerClient) {
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, PERMISSIONS.ROLES_MANAGE);
  return businessId;
}

function roleDetailsFormValues(formData: FormData) {
  return {
    name: formData.get("name"),
    description: formData.get("description"),
  };
}

export async function createRole(_prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = roleDetailsSchema.safeParse(roleDetailsFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireRolesPermission(supabase);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("createRole: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { name, description } = parsed.data;

  const { data: role, error } = await supabase
    .from("roles")
    .insert({ business_id: businessId, name, description: description || null, is_system_role: false })
    .select("id")
    .single();

  if (error || !role) {
    console.error("createRole: insert failed", error);
    if (error?.code === "23505") {
      return { error: "A role with this name already exists.", fieldErrors: { name: "Already in use." } };
    }
    return { error: "Couldn't create the role. Please try again." };
  }

  revalidatePath("/settings/roles");
  redirect(`/settings/roles/${role.id}`);
}

/**
 * Renames/re-describes a role. For a system role this only ever changes
 * the description — protect_system_role_identity() (0054) would reject a
 * rename at the database level regardless, but checking here first means
 * a locked name field never even gets sent, and the caller gets a clean
 * save instead of relying on a raw database error not surfacing weirdly.
 */
export async function updateRoleDetails(roleId: string, _prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = roleDetailsSchema.safeParse(roleDetailsFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireRolesPermission(supabase);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("updateRoleDetails: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { data: existing, error: lookupError } = await supabase
    .from("roles")
    .select("is_system_role")
    .eq("id", roleId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (lookupError) {
    console.error("updateRoleDetails: lookup failed", lookupError);
  }
  if (!existing) {
    return { error: "Couldn't find that role." };
  }

  const { name, description } = parsed.data;
  const update = existing.is_system_role ? { description: description || null } : { name, description: description || null };

  const { error } = await supabase.from("roles").update(update).eq("id", roleId).eq("business_id", businessId);

  if (error) {
    console.error("updateRoleDetails: update failed", error);
    if (error.code === "23505") {
      return { error: "A role with this name already exists.", fieldErrors: { name: "Already in use." } };
    }
    return { error: "Couldn't save changes. Please try again." };
  }

  revalidatePath("/settings/roles");
  revalidatePath(`/settings/roles/${roleId}`);
  redirect(`/settings/roles/${roleId}`);
}

export interface PermissionsFormState {
  error?: string;
  success?: boolean;
}

/** Replaces a role's entire permission set via set_role_permissions() (0054). */
export async function updateRolePermissions(
  roleId: string,
  _prevState: PermissionsFormState,
  formData: FormData
): Promise<PermissionsFormState> {
  const parsed = rolePermissionsSchema.safeParse({ permissionKeys: formData.getAll("permission") });

  if (!parsed.success) {
    return { error: "Something went wrong. Please refresh and try again." };
  }

  const supabase = await createServerSupabaseClient();

  try {
    await requireRolesPermission(supabase);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("updateRolePermissions: permission check failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { error } = await supabase.rpc("set_role_permissions", {
    p_role_id: roleId,
    p_permission_keys: parsed.data.permissionKeys,
  });

  if (error) {
    console.error("updateRolePermissions: rpc failed", error);
    return { error: friendlyRoleRpcError(error.message) };
  }

  revalidatePath(`/settings/roles/${roleId}`);
  return { success: true };
}

function friendlyRoleRpcError(message: string): string {
  if (message.includes("Owner role must always keep")) {
    return message;
  }
  if (message.includes("not found")) {
    return "Couldn't find that role.";
  }
  return "Couldn't save that change. Please try again.";
}

/**
 * Bound as `deleteRole.bind(null, roleId)`. Blocked for system roles
 * (existing roles_delete RLS policy — a 0-row, error-free no-op) and for
 * a role currently assigned to staff (prevent_assigned_role_delete
 * trigger, 0054, surfaces as a 23503 error here). The roles list/detail
 * page only ever renders the delete control for a custom, unassigned
 * role, so reaching either of these paths means something changed out
 * from under the caller mid-session, not a normal outcome.
 */
export async function deleteRole(roleId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const businessId = await requireRolesPermission(supabase);

  const { error } = await supabase.from("roles").delete().eq("id", roleId).eq("business_id", businessId);

  if (error) {
    console.error("deleteRole: delete failed", error);
    if (error.code === "23503") {
      throw new Error("This role is assigned to one or more staff members. Reassign them first.");
    }
    throw new Error("Couldn't delete this role. Please try again.");
  }

  revalidatePath("/settings/roles");
  redirect("/settings/roles");
}