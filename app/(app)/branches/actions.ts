"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { branchSchema } from "@/lib/validation/branches";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";
import { getCurrentBusinessId } from "@/lib/auth/current-business";

export interface BranchFormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

function branchFormValues(formData: FormData) {
  return {
    name: formData.get("name"),
    addressLine1: formData.get("addressLine1"),
    addressLine2: formData.get("addressLine2"),
    city: formData.get("city"),
    region: formData.get("region"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    timezone: formData.get("timezone"),
    status: formData.get("status") ?? "active",
  };
}

/**
 * Resolves the caller's business_id and checks branches.manage. Shared by
 * every mutation below â€” the UI only ever shows these forms/buttons to a
 * user who already has this permission (see hasPermission() calls in the
 * pages), but that's cosmetic; this is the real, server-side check
 * (Section 49), with RLS underneath it as the final backstop either way.
 */
async function requireBranchManager(supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>) {
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, PERMISSIONS.BRANCHES_MANAGE);
  return businessId;
}

export async function createBranch(
  _prevState: BranchFormState,
  formData: FormData
): Promise<BranchFormState> {
  const parsed = branchSchema.safeParse(branchFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireBranchManager(supabase);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { error: err.message };
    }
    console.error("createBranch: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { name, addressLine1, addressLine2, city, region, phone, email, timezone, status } = parsed.data;

  const { error } = await supabase.from("branches").insert({
    business_id: businessId,
    name,
    address_line1: addressLine1 || null,
    address_line2: addressLine2 || null,
    city: city || null,
    region: region || null,
    phone: phone || null,
    email: email || null,
    timezone,
    status,
  });

  if (error) {
    console.error("createBranch: insert failed", error);
    // 23505 = unique_violation â€” branches(business_id, name) (0003).
    if (error.code === "23505") {
      return {
        error: "A branch with this name already exists.",
        fieldErrors: { name: "A branch with this name already exists." },
      };
    }
    return { error: "Couldn't create the branch. Please try again." };
  }

  revalidatePath("/branches");
  redirect("/branches");
}

export async function updateBranch(
  branchId: string,
  _prevState: BranchFormState,
  formData: FormData
): Promise<BranchFormState> {
  const parsed = branchSchema.safeParse(branchFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireBranchManager(supabase);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { error: err.message };
    }
    console.error("updateBranch: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { name, addressLine1, addressLine2, city, region, phone, email, timezone, status } = parsed.data;

  const { error } = await supabase
    .from("branches")
    .update({
      name,
      address_line1: addressLine1 || null,
      address_line2: addressLine2 || null,
      city: city || null,
      region: region || null,
      phone: phone || null,
      email: email || null,
      timezone,
      status,
    })
    // business_id filter is belt-and-suspenders â€” RLS already scopes this,
    // but an explicit filter means a wrong/forged branchId for another
    // tenant affects 0 rows instead of relying solely on RLS to notice.
    .eq("id", branchId)
    .eq("business_id", businessId);

  if (error) {
    console.error("updateBranch: update failed", error);
    if (error.code === "23505") {
      return {
        error: "A branch with this name already exists.",
        fieldErrors: { name: "A branch with this name already exists." },
      };
    }
    return { error: "Couldn't save changes. Please try again." };
  }

  revalidatePath("/branches");
  redirect("/branches");
}

/**
 * Bound to a specific branch id from the branches list page
 * (setMainBranch.bind(null, branch.id)) and used directly as a <form
 * action>, the same no-useFormState pattern as lib/auth/sign-out.ts. Lets
 * an AuthorizationError/NoBusinessError propagate to Next's default error
 * boundary rather than returning a form state â€” acceptable here because
 * the triggering button is itself only rendered for a user who already
 * has branches.manage (cosmetic check), so a thrown error here means
 * something changed permissions out from under them mid-session, not the
 * expected path.
 */
export async function setMainBranch(branchId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  await requireBranchManager(supabase);

  const { error } = await supabase.rpc("set_main_branch", { p_branch_id: branchId });

  if (error) {
    console.error("setMainBranch: rpc failed", error);
    throw new Error("Couldn't set this branch as main. Please try again.");
  }

  revalidatePath("/branches");
}
