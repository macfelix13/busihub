"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { startTillSession, readTillSession, endTillSession } from "@/lib/auth/till-session";
import { assertValidPinFormat, InvalidPinFormatError } from "@/lib/auth/pin";
import { checkoutSchema } from "@/lib/validation/sales";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Signs a colleague in at the counter. The PIN is verified inside the
 * database (migration 0019) — the hash is never readable by any client,
 * and the lockout counter is maintained in the same call, so an attacker
 * cannot decline to report their own failures.
 */
export async function signInCashier(_prevState: FormState, formData: FormData): Promise<FormState> {
  const cashierId = String(formData.get("cashierId") ?? "");
  const pin = String(formData.get("pin") ?? "");

  if (!cashierId) {
    return { error: "Choose who is at the till." };
  }

  try {
    assertValidPinFormat(pin);
  } catch (err) {
    if (err instanceof InvalidPinFormatError) {
      return { error: "Enter your 4 to 6 digit PIN.", fieldErrors: { pin: err.message } };
    }
    throw err;
  }

  const supabase = await createServerSupabaseClient();

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, first_name, last_name")
    .eq("id", cashierId)
    .maybeSingle();

  if (profileError || !profile) {
    console.error("signInCashier: profile lookup failed", profileError);
    return { error: "That person could not be found." };
  }

  const { data: ok, error } = await supabase.rpc("verify_profile_pin", {
    p_profile_id: cashierId,
    p_pin: pin,
  });

  if (error) {
    console.error("signInCashier: rpc failed", error);
    // P0001 here is a message written for the user — locked out, no PIN
    // set, or not active — and is worth showing verbatim.
    if (error.code === "P0001" && error.message) {
      return { error: error.message };
    }
    return { error: "Couldn't check that PIN. Please try again." };
  }

  if (!ok) {
    return { error: "That PIN isn't right.", fieldErrors: { pin: "Incorrect PIN." } };
  }

  await startTillSession(profile.id, [profile.first_name, profile.last_name].filter(Boolean).join(" "));

  revalidatePath("/till");
  redirect("/till");
}

export async function signOutCashier(): Promise<void> {
  await endTillSession();
  revalidatePath("/till");
  redirect("/till");
}

/**
 * Rings up the sale.
 *
 * Note what is NOT sent: prices, tax, or totals. create_sale() takes only
 * variant ids and quantities and derives the money itself from the catalog
 * and the business's tax settings (migration 0020). The cart's figures are
 * a preview for the person at the counter; the receipt is whatever the
 * database calculated.
 */
export async function completeSale(_prevState: FormState, formData: FormData): Promise<FormState> {
  const raw = formData.get("cartJson");
  let items: unknown = [];
  if (typeof raw === "string" && raw.length > 0) {
    try {
      items = JSON.parse(raw);
    } catch {
      return { error: "Something went wrong with the cart. Please try again." };
    }
  }

  const parsed = checkoutSchema.safeParse({
    branchId: formData.get("branchId"),
    customerId: formData.get("customerId"),
    paymentMethod: formData.get("paymentMethod"),
    amountTendered: formData.get("amountTendered"),
    items,
  });

  if (!parsed.success) {
    const fieldErrors = zodFieldErrors(parsed.error);
    return { error: fieldErrors.items ?? "Please fix the errors below.", fieldErrors };
  }

  const supabase = await createServerSupabaseClient();

  try {
    const businessId = await getCurrentBusinessId(supabase);
    await requirePermission(supabase, businessId, PERMISSIONS.SALES_PROCESS);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("completeSale: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  // The cashier comes from the signed till cookie, never from the form —
  // otherwise a sale could be attributed to anyone.
  const till = await readTillSession();

  const { branchId, customerId, paymentMethod, amountTendered, items: lines } = parsed.data;

  const { data: saleId, error } = await supabase.rpc("create_sale", {
    p_branch_id: branchId,
    p_cashier_id: till?.cashierId ?? null,
    p_customer_id: customerId || null,
    p_payment_method: paymentMethod,
    p_amount_tendered: paymentMethod === "cash" ? amountTendered : 0,
    p_items: lines.map((line) => ({ variant_id: line.variantId, quantity: line.quantity })),
  });

  if (error) {
    console.error("completeSale: rpc failed", error);
    // The database's messages here are written for a person at a counter
    // — "Not enough stock", "over their credit limit", "Not enough cash
    // tendered" — and each names something they can act on.
    if (error.code === "P0001" && error.message) {
      return { error: error.message };
    }
    if (error.code === "P0002") {
      return { error: "A product, branch or customer on this sale could not be found." };
    }
    if (error.code === "42501") {
      return { error: "You don't have permission to complete a sale." };
    }
    return { error: "Couldn't complete the sale. Please try again." };
  }

  revalidatePath("/till");
  revalidatePath("/inventory");
  redirect(`/sales/${saleId as string}`);
}
