"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { receiveStockSchema, adjustStockSchema, stockCountSchema, adjustmentReasonLabel } from "@/lib/validation/inventory";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

type SupabaseServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

async function requireInventoryPermission(supabase: SupabaseServerClient, permission: PermissionKey) {
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, permission);
  return businessId;
}

/**
 * The database raises P0001 with a human-readable message for the two
 * business rules it enforces itself (not enough stock; nothing to
 * record). Surfacing that text is deliberate: it is written for a user,
 * it is the only place the check can be made race-free, and hiding it
 * behind a generic "something went wrong" would tell the user nothing
 * about a situation they can actually fix.
 *
 * Everything else stays generic — a raw Postgres error is never shown.
 */
function stockErrorMessage(error: { code?: string; message?: string } | null): string | null {
  if (!error) return null;
  if (error.code === "P0001" && error.message) {
    if (error.message.includes("Not enough stock")) {
      return "There isn't enough stock on hand for that. Check the current quantity and try again.";
    }
    if (error.message.includes("different businesses")) {
      return "That product isn't available at that branch.";
    }
  }
  if (error.code === "P0002") {
    return "That branch or product could not be found.";
  }
  return null;
}

/**
 * Cache invalidation shared by the three actions below. The redirect that
 * follows it is written out at each call site rather than wrapped in here
 * with it: redirect() throws, and TypeScript only treats the code after
 * it as unreachable when the call is directly in the action's own body —
 * behind a helper, the action would look like it falls off the end
 * without returning a FormState. Same shape as products/actions.ts.
 */
function revalidateInventory(variantId: string): void {
  revalidatePath("/inventory");
  revalidatePath(`/inventory/${variantId}`);
}

export async function receiveStock(_prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = receiveStockSchema.safeParse({
    branchId: formData.get("branchId"),
    variantId: formData.get("variantId"),
    quantity: formData.get("quantity"),
    note: formData.get("note"),
  });

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  try {
    await requireInventoryPermission(supabase, PERMISSIONS.INVENTORY_RECEIVE);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("receiveStock: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { branchId, variantId, quantity, note } = parsed.data;

  // business_id is deliberately omitted: set_inventory_movement_context()
  // (migration 0015) derives it from the branch and overwrites whatever
  // is sent, so supplying it here would be theatre. The column is NOT
  // NULL, but the BEFORE INSERT trigger fills it before the constraint is
  // checked.
  const { error } = await supabase.from("inventory_movements").insert({
    branch_id: branchId,
    variant_id: variantId,
    quantity_delta: quantity,
    reason: "receive",
    note: note || null,
  });

  if (error) {
    console.error("receiveStock: insert failed", error);
    return { error: stockErrorMessage(error) ?? "Couldn't record the stock receipt. Please try again." };
  }

  revalidateInventory(variantId);
  redirect(`/inventory?branch=${encodeURIComponent(branchId)}`);
}

export async function adjustStock(_prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = adjustStockSchema.safeParse({
    branchId: formData.get("branchId"),
    variantId: formData.get("variantId"),
    direction: formData.get("direction"),
    quantity: formData.get("quantity"),
    reason: formData.get("reason"),
    note: formData.get("note"),
  });

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  try {
    await requireInventoryPermission(supabase, PERMISSIONS.INVENTORY_ADJUST);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("adjustStock: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { branchId, variantId, direction, quantity, reason, note } = parsed.data;
  const delta = direction === "decrease" ? -quantity : quantity;

  // The user-facing reason lives in the note, not in reason — see the
  // comment on ADJUSTMENT_REASONS in lib/validation/inventory.ts.
  const composedNote = note ? `${adjustmentReasonLabel(reason)}: ${note}` : adjustmentReasonLabel(reason);

  const { error } = await supabase.from("inventory_movements").insert({
    branch_id: branchId,
    variant_id: variantId,
    quantity_delta: delta,
    reason: "adjustment",
    note: composedNote,
  });

  if (error) {
    console.error("adjustStock: insert failed", error);
    return { error: stockErrorMessage(error) ?? "Couldn't record the adjustment. Please try again." };
  }

  revalidateInventory(variantId);
  redirect(`/inventory?branch=${encodeURIComponent(branchId)}`);
}

export async function recordStockCount(_prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = stockCountSchema.safeParse({
    branchId: formData.get("branchId"),
    variantId: formData.get("variantId"),
    countedQuantity: formData.get("countedQuantity"),
    note: formData.get("note"),
  });

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  try {
    await requireInventoryPermission(supabase, PERMISSIONS.INVENTORY_ADJUST);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("recordStockCount: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { branchId, variantId, countedQuantity, note } = parsed.data;

  // Goes through the RPC rather than a plain insert because the delta has
  // to be computed from the current level under a lock — see the function
  // comment in migration 0015.
  const { error } = await supabase.rpc("record_stock_count", {
    p_branch_id: branchId,
    p_variant_id: variantId,
    p_counted_quantity: countedQuantity,
    p_note: note || null,
  });

  if (error) {
    console.error("recordStockCount: rpc failed", error);
    return { error: stockErrorMessage(error) ?? "Couldn't record the count. Please try again." };
  }

  revalidateInventory(variantId);
  redirect(`/inventory?branch=${encodeURIComponent(branchId)}`);
}
