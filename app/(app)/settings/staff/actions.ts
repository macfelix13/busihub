"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { inviteStaffSchema } from "@/lib/validation/staff";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";
import { supabaseAppUrl } from "@/lib/env";

export interface InviteFormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Invites a new colleague. Two steps, deliberately not one function,
 * because they need two different privilege levels:
 *
 *  1. Creating the auth.users row is a Supabase Auth Admin API call
 *     (inviteUserByEmail — sends Supabase's own "set your password" email,
 *     no separate email service needed), which only the service-role
 *     client can make. This is the one place this file uses it, and it
 *     does nothing tenant-sensitive on its own — it just creates a
 *     credential with no profile attached to it yet.
 *  2. Everything that actually matters for tenant isolation (which
 *     business, which branch, which role) happens in invite_staff_member()
 *     (supabase/migrations/0036), called through the caller's own
 *     RLS-scoped session so it re-derives the caller's business_id and
 *     re-checks users.manage itself — never trusted from this action
 *     alone, exactly like every other mutation in this app (Section 49).
 */
export async function inviteStaff(_prevState: InviteFormState, formData: FormData): Promise<InviteFormState> {
  const parsed = inviteStaffSchema.safeParse({
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName"),
    email: formData.get("email"),
    branchId: formData.get("branchId"),
    roleId: formData.get("roleId"),
  });

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const { firstName, lastName, email, branchId, roleId } = parsed.data;

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await getCurrentBusinessId(supabase);
    await requirePermission(supabase, businessId, PERMISSIONS.USERS_MANAGE);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { error: err.message };
    }
    console.error("inviteStaff: permission check failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  // Defense in depth: the <select> options are already scoped to this
  // business, but a request is never trusted just because a legitimate
  // form could have produced it (Section 7) — re-verify both ids belong
  // to the caller's own business before ever calling the Auth Admin API.
  const [{ data: branch }, { data: role }] = await Promise.all([
    supabase.from("branches").select("id").eq("id", branchId).eq("business_id", businessId).maybeSingle(),
    supabase.from("roles").select("id").eq("id", roleId).eq("business_id", businessId).maybeSingle(),
  ]);

  if (!branch) {
    return { error: "Choose a valid branch.", fieldErrors: { branchId: "Choose a valid branch." } };
  }
  if (!role) {
    return { error: "Choose a valid role.", fieldErrors: { roleId: "Choose a valid role." } };
  }

  const admin = createServiceRoleClient();
  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${supabaseAppUrl()}/auth/confirm?next=/dashboard`,
    data: { first_name: firstName, last_name: lastName },
  });

  if (inviteError || !invited?.user) {
    // Never forward the raw Supabase error to the client (Section 38) —
    // but the "already registered" case is common enough (re-inviting by
    // mistake, or the person already has some other Busihub account) to
    // deserve a specific, actionable message rather than a generic one.
    console.error("inviteStaff: inviteUserByEmail failed", {
      status: inviteError?.status,
      message: inviteError?.message,
    });
    const alreadyExists = inviteError?.message?.toLowerCase().includes("already") ?? false;
    return {
      error: alreadyExists
        ? "An account with this email already exists. If you already invited them, ask them to check their email (including spam) — otherwise use a different address."
        : "We couldn't send the invite right now. Please try again.",
      fieldErrors: alreadyExists ? { email: "Already registered." } : undefined,
    };
  }

  const { error: rpcError } = await supabase.rpc("invite_staff_member", {
    p_invited_user_id: invited.user.id,
    p_branch_id: branchId,
    p_role_id: roleId,
    p_first_name: firstName,
    p_last_name: lastName ?? "",
    p_email: email,
  });

  if (rpcError) {
    // The invite email has already been sent — the auth.users row exists
    // with no profile attached, the same safe-orphan state docs/AUTH.md
    // already documents for a stalled self-registration. Nothing else in
    // the schema lets that account read or write tenant data, so this is
    // inert, not a security hole — but the owner needs a truthful message,
    // not "success", since something did go wrong.
    console.error("inviteStaff: invite_staff_member failed", rpcError);
    return {
      error:
        `The invite email to ${email} was sent, but we couldn't finish setting up their account on our side. ` +
        "Please try inviting them again in a moment, or contact support if it keeps happening.",
    };
  }

  revalidatePath("/settings/staff");
  redirect("/settings/staff");
}

export interface RoleFormState {
  error?: string;
  success?: boolean;
}

/** Replaces (or, with an empty roleId, removes) a colleague's role at one branch. */
export async function changeStaffRole(_prevState: RoleFormState, formData: FormData): Promise<RoleFormState> {
  const userId = String(formData.get("userId") ?? "");
  const branchId = String(formData.get("branchId") ?? "");
  const roleIdRaw = String(formData.get("roleId") ?? "");
  const roleId = roleIdRaw === "" ? null : roleIdRaw;

  if (!userId || !branchId) {
    return { error: "Something went wrong. Please refresh and try again." };
  }

  const supabase = await createServerSupabaseClient();

  try {
    const businessId = await getCurrentBusinessId(supabase);
    await requirePermission(supabase, businessId, PERMISSIONS.USERS_MANAGE);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { error: err.message };
    }
    console.error("changeStaffRole: permission check failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { error } = await supabase.rpc("update_staff_role", {
    p_user_id: userId,
    p_branch_id: branchId,
    p_new_role_id: roleId,
  });

  if (error) {
    console.error("changeStaffRole: rpc failed", error);
    return { error: friendlyStaffRpcError(error.message) };
  }

  revalidatePath(`/settings/staff/${userId}`);
  revalidatePath("/settings/staff");
  return { success: true };
}

function friendlyStaffRpcError(message: string): string {
  if (message.includes("own role") || message.includes("own status")) {
    return "You can't change your own role or status here.";
  }
  if (message.includes("business.manage")) {
    return "Only an Owner can grant the Owner role.";
  }
  if (message.includes("no active Owner")) {
    return "This would leave the business with no active Owner. Assign Owner to someone else first.";
  }
  if (message.includes("not found")) {
    return "Couldn't find that staff member.";
  }
  return "Couldn't save that change. Please try again.";
}

/** Bound as `deactivateStaffMember.bind(null, userId)` — see components/ui/button.tsx's StatusToggleButton. */
export async function deactivateStaffMember(userId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, PERMISSIONS.USERS_MANAGE);

  const { error } = await supabase.rpc("set_staff_status", { p_user_id: userId, p_new_status: "inactive" });
  if (error) {
    console.error("deactivateStaffMember: rpc failed", error);
    throw new Error(friendlyStaffRpcError(error.message));
  }

  revalidatePath(`/settings/staff/${userId}`);
  revalidatePath("/settings/staff");
}

/** Bound as `reactivateStaffMember.bind(null, userId)`. */
export async function reactivateStaffMember(userId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, PERMISSIONS.USERS_MANAGE);

  const { error } = await supabase.rpc("set_staff_status", { p_user_id: userId, p_new_status: "active" });
  if (error) {
    console.error("reactivateStaffMember: rpc failed", error);
    throw new Error(friendlyStaffRpcError(error.message));
  }

  revalidatePath(`/settings/staff/${userId}`);
  revalidatePath("/settings/staff");
}