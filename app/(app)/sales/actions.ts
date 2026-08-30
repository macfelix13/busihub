"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { readTillSession } from "@/lib/auth/till-session";
import { refundSchema } from "@/lib/validation/refunds";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * The database writes these messages for a person standing at a counter —
 * "Only 3 of X is left to refund", "this sale has been refunded and
 * cannot be voided" — and each names something they can act on, so they
 * are surfaced rather than flattened into a generic failure.
 */
function correctionErrorMessage(error: { code?: string; message?: string } | null): string | null {
  if (!error) return null;
  if (error.code === "P0001" && error.message) return error.message;
  if (error.code === "P0002") return "That sale or line could not be found.";
  if (error.code === "42501") return "You don't have permission to do that.";
  return null;
}

/** Cancels a whole sale. Only rendered for a caller who already has sales.void. */
export async function voidSale(saleId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, PERMISSIONS.SALES_VOID);

  const { error } = await supabase.rpc("void_sale", { p_sale_id: saleId, p_reason: null });

  if (error) {
    console.error("voidSale: rpc failed", error);
    throw new Error(correctionErrorMessage(error) ?? "Couldn't void this sale. Please try again.");
  }

  revalidatePath(`/sales/${saleId}`);
  revalidatePath("/inventory");
}

export async function refundSale(saleId: string, _prevState: FormState, formData: FormData): Promise<FormState> {
  const raw = formData.get("linesJson");
  let lines: unknown = [];
  if (typeof raw === "string" && raw.length > 0) {
    try {
      lines = JSON.parse(raw);
    } catch {
      return { error: "Something went wrong with the return. Please try again." };
    }
  }

  const parsed = refundSchema.safeParse({
    method: formData.get("method"),
    reason: formData.get("reason"),
    lines,
  });

  if (!parsed.success) {
    const fieldErrors = zodFieldErrors(parsed.error);
    return { error: fieldErrors.lines ?? "Please fix the errors below.", fieldErrors };
  }

  const supabase = await createServerSupabaseClient();

  try {
    const businessId = await getCurrentBusinessId(supabase);
    await requirePermission(supabase, businessId, PERMISSIONS.SALES_REFUND);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("refundSale: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  // Who handled the return, from the signed till cookie — never the form.
  const till = await readTillSession();
  const { method, reason, lines: refundLines } = parsed.data;

  const { error } = await supabase.rpc("create_refund", {
    p_sale_id: saleId,
    p_cashier_id: till?.cashierId ?? null,
    p_method: method,
    p_reason: reason || null,
    // Amounts are NOT sent: create_refund apportions them from the
    // original sale line, so a customer gets back what they paid.
    p_items: refundLines
      .filter((l) => l.quantity > 0)
      .map((l) => ({ sale_item_id: l.saleItemId, quantity: l.quantity, restock: l.restock })),
  });

  if (error) {
    console.error("refundSale: rpc failed", error);
    return { error: correctionErrorMessage(error) ?? "Couldn't record this return. Please try again." };
  }

  revalidatePath(`/sales/${saleId}`);
  revalidatePath("/inventory");
  redirect(`/sales/${saleId}`);
}
