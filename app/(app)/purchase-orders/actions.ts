"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import {
  createPurchaseOrderSchema,
  receivePurchaseOrderSchema,
  type PurchaseOrderLineInput,
} from "@/lib/validation/purchasing";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

type SupabaseServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

async function requirePurchasingPermission(supabase: SupabaseServerClient, permission: PermissionKey) {
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, permission);
  return businessId;
}

function jsonField<T>(formData: FormData, name: string, fallback: T): T {
  const raw = formData.get(name);
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * The database enforces the purchasing rules itself (migration 0016), and
 * raises messages written for a person. These are surfaced deliberately —
 * each describes a situation the user can actually act on — while
 * anything unrecognized stays generic rather than leaking raw SQL.
 */
function purchasingErrorMessage(error: { code?: string; message?: string } | null): string | null {
  if (!error) return null;

  // The not-over-received check constraint.
  if (error.code === "23514" && (error.message ?? "").includes("not_over_received")) {
    return "That's more than was ordered on one of these lines. Check the quantities and try again.";
  }

  if (error.code === "P0001" && error.message) {
    const message = error.message;
    if (message.includes("not approved for receiving")) {
      return "This order isn't approved for receiving yet.";
    }
    if (message.includes("no longer a draft") || message.includes("no longer be edited")) {
      return "This order has been approved and can no longer be edited.";
    }
    if (message.includes("Cannot move a purchase order")) {
      return "That isn't a valid next step for this order.";
    }
    if (message.includes("Nothing to receive")) {
      return "Enter a quantity for at least one line.";
    }
    if (message.includes("different businesses")) {
      return "That product or branch isn't available for this supplier.";
    }
    if (message.includes("at least one line")) {
      return "Add at least one product to the order.";
    }
    if (message.includes("cannot be reduced")) {
      return "A received quantity can't be reduced. Record a stock adjustment instead.";
    }
  }

  if (error.code === "P0002") {
    return "That order, line, supplier or product could not be found.";
  }

  if (error.code === "42501") {
    return "You don't have permission to do that.";
  }

  return null;
}

export async function createPurchaseOrder(_prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = createPurchaseOrderSchema.safeParse({
    supplierId: formData.get("supplierId"),
    branchId: formData.get("branchId"),
    expectedDate: formData.get("expectedDate"),
    notes: formData.get("notes"),
    lines: jsonField<unknown[]>(formData, "linesJson", []),
  });

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  try {
    await requirePurchasingPermission(supabase, PERMISSIONS.PURCHASE_ORDERS_CREATE);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("createPurchaseOrder: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { supplierId, branchId, expectedDate, notes, lines } = parsed.data;

  const { data, error } = await supabase.rpc("create_purchase_order", {
    p_supplier_id: supplierId,
    p_branch_id: branchId,
    p_expected_date: expectedDate || null,
    p_notes: notes || null,
    p_items: lines.map((line: PurchaseOrderLineInput) => ({
      variant_id: line.variantId,
      quantity_ordered: line.quantityOrdered,
      unit_cost: line.unitCost,
    })),
  });

  if (error) {
    console.error("createPurchaseOrder: rpc failed", error);
    return { error: purchasingErrorMessage(error) ?? "Couldn't create the purchase order. Please try again." };
  }

  revalidatePath("/purchase-orders");
  redirect(`/purchase-orders/${data as string}`);
}

/**
 * Approve / cancel are plain bound actions rather than form-state ones:
 * they take no user input beyond the order id, and the buttons are only
 * rendered for a caller who already has purchase_orders.approve. A thrown
 * error here means permissions or the order's status changed underneath
 * them, not the expected path.
 */
export async function approvePurchaseOrder(purchaseOrderId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  await requirePurchasingPermission(supabase, PERMISSIONS.PURCHASE_ORDERS_APPROVE);

  const { error } = await supabase.rpc("approve_purchase_order", { p_purchase_order_id: purchaseOrderId });

  if (error) {
    console.error("approvePurchaseOrder: rpc failed", error);
    throw new Error(purchasingErrorMessage(error) ?? "Couldn't approve this order. Please try again.");
  }

  revalidatePath("/purchase-orders");
  revalidatePath(`/purchase-orders/${purchaseOrderId}`);
}

export async function cancelPurchaseOrder(purchaseOrderId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  await requirePurchasingPermission(supabase, PERMISSIONS.PURCHASE_ORDERS_APPROVE);

  const { error } = await supabase.rpc("cancel_purchase_order", { p_purchase_order_id: purchaseOrderId });

  if (error) {
    console.error("cancelPurchaseOrder: rpc failed", error);
    throw new Error(purchasingErrorMessage(error) ?? "Couldn't cancel this order. Please try again.");
  }

  revalidatePath("/purchase-orders");
  revalidatePath(`/purchase-orders/${purchaseOrderId}`);
}

export async function receivePurchaseOrder(
  purchaseOrderId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  const parsed = receivePurchaseOrderSchema.safeParse({
    note: formData.get("note"),
    receipts: jsonField<unknown[]>(formData, "receiptsJson", []),
  });

  if (!parsed.success) {
    const fieldErrors = zodFieldErrors(parsed.error);
    return {
      // The "nothing entered" case is attached to the array itself, and is
      // the one the user is most likely to hit.
      error: fieldErrors.receipts ?? "Please fix the errors below.",
      fieldErrors,
    };
  }

  const supabase = await createServerSupabaseClient();

  // Receiving goods is the inventory privilege, not a purchasing one —
  // the same permission manual receiving requires (see 0016's header).
  try {
    await requirePurchasingPermission(supabase, PERMISSIONS.INVENTORY_RECEIVE);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("receivePurchaseOrder: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { note, receipts } = parsed.data;

  const { error } = await supabase.rpc("receive_purchase_order", {
    p_purchase_order_id: purchaseOrderId,
    p_receipts: receipts.filter((r) => r.quantity > 0).map((r) => ({ item_id: r.itemId, quantity: r.quantity })),
    p_note: note || null,
  });

  if (error) {
    console.error("receivePurchaseOrder: rpc failed", error);
    return { error: purchasingErrorMessage(error) ?? "Couldn't record this delivery. Please try again." };
  }

  revalidatePath("/purchase-orders");
  revalidatePath(`/purchase-orders/${purchaseOrderId}`);
  revalidatePath("/inventory");
  redirect(`/purchase-orders/${purchaseOrderId}`);
}
