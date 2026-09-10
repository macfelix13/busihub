"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { refundSchema } from "@/lib/validation/refunds";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";
import { loadPaystackCredentials, verifyTransaction, submitChargeOtp } from "@/lib/paystack/client";

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

  // Who handled the return: create_refund() (0039) always attributes it
  // to whoever's actual Supabase session made this call — there is no
  // longer a separate "who's at the till" identity to read here at all.
  const { method, reason, lines: refundLines } = parsed.data;

  const { error } = await supabase.rpc("create_refund", {
    p_sale_id: saleId,
    p_cashier_id: null,
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

/**
 * Asks Paystack directly whether a pending charge has landed.
 *
 * The webhook is the primary path and usually wins. This is the fallback
 * for when it is slow or lost — Paystack's own advice is to verify if
 * nothing has arrived within 180 seconds — and it settles through exactly
 * the same function the webhook uses, so there is one place where a sale
 * becomes paid, not two.
 */
export interface PaymentCheck {
  /** The SALE's status: awaiting_payment, completed, cancelled, … */
  status: string;
  /**
   * The momo tender's own status. This is the part that was missing: a
   * declined prompt leaves the SALE awaiting_payment (correctly — the
   * goods are still off the shelf and someone must decide what to do),
   * so reporting only the sale status made "the customer said no"
   * indistinguishable from "still waiting", and the till counted up for
   * three minutes as though nothing had happened.
   */
  paymentStatus?: string;
  failureReason?: string | null;
  error?: string;
}

export async function checkSalePayment(saleId: string): Promise<PaymentCheck> {
  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await getCurrentBusinessId(supabase);
    await requirePermission(supabase, businessId, PERMISSIONS.SALES_PROCESS);
  } catch (err) {
    if (err instanceof AuthorizationError) return { status: "unknown", error: err.message };
    console.error("checkSalePayment: permission lookup failed", err);
    return { status: "unknown", error: "Something went wrong." };
  }

  // Read through the caller's own client, so RLS decides whether this
  // sale is theirs to look at. Everything after this point uses the
  // service role, and would not.
  const { data: saleRow, error: saleError } = await supabase
    .from("sales")
    .select("id, status")
    .eq("id", saleId)
    .maybeSingle();

  const sale = saleRow as { id: string; status: string } | null;

  if (saleError || !sale) {
    return { status: "unknown", error: "That sale could not be found." };
  }

  if (sale.status !== "awaiting_payment") {
    return { status: sale.status };
  }

  const { data: paymentRow } = await supabase
    .from("sale_payments")
    .select("id, status, failure_reason, awaiting_otp")
    .eq("sale_id", saleId)
    .eq("method", "momo")
    .maybeSingle();

  const payment = paymentRow as {
    id: string;
    status: string;
    failure_reason: string | null;
    awaiting_otp: boolean;
  } | null;
  if (!payment) {
    return { status: sale.status };
  }
  if (payment.status !== "pending") {
    // Already settled — very often FAILED, because the customer declined
    // the prompt. The till needs to hear that, not just the sale status.
    return { status: sale.status, paymentStatus: payment.status, failureReason: payment.failure_reason };
  }

  if (payment.awaiting_otp) {
    // Genuinely waiting on a code someone has to type into submitMomoOtp()
    // — deliberately NOT calling verifyTransaction() here. A real report
    // (2026-09): the OTP entry screen kept getting yanked away to
    // "declined" seconds after appearing, well before a cashier could
    // realistically read an SMS and type it in. verifyTransaction() is a
    // fallback for a SLOW WEBHOOK on a charge that's otherwise already
    // decided on the customer's phone — it was never meant to referee an
    // OTP-gated charge where the actual deciding step is the cashier's own
    // submission, and Paystack's own status can look abandoned-ish mid-flow
    // in a way that doesn't mean a code can no longer be accepted. A real
    // webhook-driven settlement is still caught immediately above (this
    // function reads the DB first); only the extra outbound guess is
    // skipped, so the cashier gets the whole window to actually try.
    return { status: sale.status, paymentStatus: "pending" };
  }

  const credentials = await loadPaystackCredentials(businessId);
  if (!credentials) {
    return { status: sale.status, error: "This shop's Paystack account is no longer connected." };
  }

  const verified = await verifyTransaction(credentials, payment.id);
  if (!verified || verified.status === "pending") {
    // Still waiting, or Paystack did not answer. Either way nothing has
    // changed, and reporting "failed" here would throw away a payment the
    // customer may be about to approve.
    return { status: sale.status, paymentStatus: "pending" };
  }

  const admin = createServiceRoleClient();
  const { data: settled, error: settleError } = await admin.rpc("settle_sale_payment", {
    p_business_id: businessId,
    p_payment_id: payment.id,
    p_status: verified.status,
    p_provider_charge_id: verified.chargeId,
    p_failure_reason: verified.status === "failed" ? (verified.message ?? "Payment failed") : null,
  });

  if (settleError) {
    console.error("checkSalePayment: settlement failed", settleError);
    return { status: sale.status, paymentStatus: "pending", error: "Couldn't confirm that payment. Please try again." };
  }

  revalidatePath(`/sales/${saleId}`);
  revalidatePath("/inventory");

  return {
    status: settled === "completed" ? "completed" : sale.status,
    paymentStatus: verified.status,
    failureReason: verified.status === "failed" ? (verified.message ?? "The customer did not approve it") : null,
  };
}

/**
 * Submits the one-time code Paystack texted the customer, for a momo
 * tender that is specifically waiting on one (sale_payments.awaiting_otp).
 *
 * This is the piece that was entirely missing: Paystack can answer a
 * charge with "I've texted the customer a code" instead of a direct
 * approval prompt, and that charge then never settles — not by webhook,
 * not by verifyTransaction() polling — until this exact call is made.
 * Without it the charge just sits there until Paystack's own window runs
 * out and it reads as an unexplained decline.
 *
 * Settles through the same settle_sale_payment() the webhook and
 * checkSalePayment() use, so there is still exactly one place a sale
 * becomes paid.
 */
export async function submitMomoOtp(saleId: string, otp: string): Promise<PaymentCheck> {
  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await getCurrentBusinessId(supabase);
    await requirePermission(supabase, businessId, PERMISSIONS.SALES_PROCESS);
  } catch (err) {
    if (err instanceof AuthorizationError) return { status: "unknown", error: err.message };
    console.error("submitMomoOtp: permission lookup failed", err);
    return { status: "unknown", error: "Something went wrong." };
  }

  const trimmedOtp = otp.trim();
  if (!/^\d{3,10}$/.test(trimmedOtp)) {
    return { status: "unknown", error: "Enter the code Paystack sent the customer." };
  }

  // Read through the caller's own client, so RLS decides whether this
  // sale is theirs to look at. Everything after this point uses the
  // service role, and would not.
  const { data: saleRow, error: saleError } = await supabase
    .from("sales")
    .select("id, status")
    .eq("id", saleId)
    .maybeSingle();

  const sale = saleRow as { id: string; status: string } | null;

  if (saleError || !sale) {
    return { status: "unknown", error: "That sale could not be found." };
  }

  if (sale.status !== "awaiting_payment") {
    return { status: sale.status };
  }

  const { data: paymentRow } = await supabase
    .from("sale_payments")
    .select("id, status, failure_reason, awaiting_otp")
    .eq("sale_id", saleId)
    .eq("method", "momo")
    .maybeSingle();

  const payment = paymentRow as {
    id: string;
    status: string;
    failure_reason: string | null;
    awaiting_otp: boolean;
  } | null;

  if (!payment) {
    return { status: sale.status };
  }
  if (payment.status !== "pending") {
    return { status: sale.status, paymentStatus: payment.status, failureReason: payment.failure_reason };
  }
  if (!payment.awaiting_otp) {
    // Nothing here is actually waiting on a code — either this charge
    // never needed one, or it already settled between the till loading
    // this screen and the cashier submitting the form. Report what's
    // true rather than pretending the submission did something.
    return { status: sale.status, paymentStatus: "pending" };
  }

  const credentials = await loadPaystackCredentials(businessId);
  if (!credentials) {
    return { status: sale.status, error: "This shop's Paystack account is no longer connected." };
  }

  const result = await submitChargeOtp(credentials, payment.id, trimmedOtp);

  if (!result.ok || result.status === "pending" || result.status === "otp_required") {
    // A wrong code, a network hiccup, or Paystack still deciding — none of
    // these are the payment failing, so the tender stays pending and the
    // cashier can have the customer try again.
    return {
      status: sale.status,
      paymentStatus: "pending",
      error: result.message ?? "That code wasn't accepted. Please check it and try again.",
    };
  }

  const admin = createServiceRoleClient();
  const { data: settled, error: settleError } = await admin.rpc("settle_sale_payment", {
    p_business_id: businessId,
    p_payment_id: payment.id,
    p_status: result.status,
    p_provider_charge_id: result.chargeId,
    p_failure_reason: result.status === "failed" ? (result.message ?? "Payment failed") : null,
  });

  if (settleError) {
    console.error("submitMomoOtp: settlement failed", settleError);
    return { status: sale.status, paymentStatus: "pending", error: "Couldn't confirm that payment. Please try again." };
  }

  revalidatePath(`/sales/${saleId}`);
  revalidatePath("/inventory");

  return {
    status: settled === "completed" ? "completed" : sale.status,
    paymentStatus: result.status,
    failureReason: result.status === "failed" ? (result.message ?? "The code was not accepted") : null,
  };
}

/**
 * Gives up on a sale whose payment never arrived. Not a void — nothing
 * was ever paid — so the goods simply go back on the shelf.
 */
export async function cancelSale(saleId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, PERMISSIONS.SALES_PROCESS);

  const { error } = await supabase.rpc("cancel_unpaid_sale", {
    p_sale_id: saleId,
    p_reason: "Cancelled at the till",
  });

  if (error) {
    console.error("cancelSale: rpc failed", error);
    throw new Error(correctionErrorMessage(error) ?? "Couldn't cancel this sale. Please try again.");
  }

  revalidatePath(`/sales/${saleId}`);
  revalidatePath("/inventory");
}