"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { categorySchema } from "@/lib/validation/categories";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

type SupabaseServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

async function requireCategoryPermission(supabase: SupabaseServerClient, permission: PermissionKey) {
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, permission);
  return businessId;
}

function categoryFormValues(formData: FormData) {
  return {
    name: formData.get("name"),
    description: formData.get("description"),
    icon: formData.get("icon"),
  };
}

export async function createCategory(_prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = categorySchema.safeParse(categoryFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    // Reuses products.create — this project has never backfilled a new
    // permission onto an already-registered business's roles, so
    // categories deliberately ride on the same permission products
    // themselves use. See migration 0041's file header.
    businessId = await requireCategoryPermission(supabase, PERMISSIONS.PRODUCTS_CREATE);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("createCategory: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { name, description, icon } = parsed.data;

  const { error } = await supabase.from("categories").insert({
    business_id: businessId,
    name,
    description: description || null,
    icon: icon || null,
  });

  if (error) {
    console.error("createCategory: insert failed", error);
    if (error.code === "23505") {
      return { error: "A category with this name already exists.", fieldErrors: { name: "Already in use." } };
    }
    return { error: "Couldn't create the category. Please try again." };
  }

  revalidatePath("/products/categories");
  revalidatePath("/products");
  redirect("/products/categories");
}

export async function updateCategory(categoryId: string, _prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = categorySchema.safeParse(categoryFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireCategoryPermission(supabase, PERMISSIONS.PRODUCTS_EDIT);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("updateCategory: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { name, description, icon } = parsed.data;

  const { error } = await supabase
    .from("categories")
    .update({ name, description: description || null, icon: icon || null })
    // business_id filter is belt-and-suspenders beyond RLS (Section 49) —
    // a wrong/forged categoryId for another tenant affects 0 rows.
    .eq("id", categoryId)
    .eq("business_id", businessId);

  if (error) {
    console.error("updateCategory: update failed", error);
    if (error.code === "23505") {
      return { error: "A category with this name already exists.", fieldErrors: { name: "Already in use." } };
    }
    return { error: "Couldn't save changes. Please try again." };
  }

  revalidatePath("/products/categories");
  revalidatePath("/products");
  redirect("/products/categories");
}

/**
 * Plain (no useFormState) action bound to a category id and target
 * status, same pattern as products/actions.ts's setProductStatus — the
 * triggering button is only ever rendered for a caller who already has
 * products.edit (cosmetic check), so a thrown error here means
 * permissions changed out from under them mid-session.
 */
export async function setCategoryStatus(categoryId: string, status: "active" | "archived"): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const businessId = await requireCategoryPermission(supabase, PERMISSIONS.PRODUCTS_EDIT);

  const { error } = await supabase.from("categories").update({ status }).eq("id", categoryId).eq("business_id", businessId);

  if (error) {
    console.error("setCategoryStatus: update failed", error);
    throw new Error("Couldn't update the category's status. Please try again.");
  }

  revalidatePath("/products/categories");
  revalidatePath("/products");
}