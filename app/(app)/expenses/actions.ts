"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { expenseSchema, voidExpenseSchema } from "@/lib/validation/expenses";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Server actions for expenses.
 *
 * Note what is NOT sent to the database: no business id, no author, no
 * reference number. `create_expense()` derives all three — the business
 * from the branch, the author from the session, the number from its own
 * sequence — so there is nothing here for a caller to forge and nothing
 * for this file to get wrong. The permission check below is a courtesy
 * that produces a good message; the reason a cashier cannot record an
 * expense is the RLS policy on the table.
 */

/**
 * The database writes its errors for a person to read (migration 0031),
 * so the recognised ones are passed through and everything else becomes
 * a generic message. A raw Postgres error names columns, constraints and
 * functions, none of which belongs on a shopkeeper's screen.
 */
function expenseErrorMessage(error: { code?: string; message?: string } | null): string | null {
  if (!error) return null;

  if (error.code === "P0001" && error.message) {
    const message = error.message;
    if (
      message.includes("future") ||
      message.includes("greater than zero") ||
      message.includes("spent on") ||
      message.includes("where the money came from") ||
      message.includes("already been voided") ||
      message.includes("why this expense")
    ) {
      return message;
    }
    if (message.includes("different businesses")) {
      return "That category isn't available for this branch.";
    }
  }
  if (error.code === "P0002") {
    return "That expense, branch or category could not be found.";
  }
  if (error.code === "42501") {
    return "You don't have permission to do that.";
  }
  return null;
}

export async function recordExpense(_prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = expenseSchema.safeParse({
    branchId: formData.get("branchId"),
    categoryId: formData.get("categoryId"),
    description: formData.get("description"),
    amount: formData.get("amount"),
    expenseDate: formData.get("expenseDate"),
    paidFrom: formData.get("paidFrom"),
    paymentReference: formData.get("paymentReference"),
    note: formData.get("note"),
  });

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  try {
    const businessId = await getCurrentBusinessId(supabase);
    await requirePermission(supabase, businessId, PERMISSIONS.EXPENSES_CREATE);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("recordExpense: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { error } = await supabase.rpc("create_expense", {
    p_branch_id: parsed.data.branchId,
    // An empty string is "no category chosen", which is allowed. It has
    // to become null rather than being sent as "" — a uuid column would
    // reject the empty string with a type error the user cannot act on.
    p_category_id: parsed.data.categoryId ? parsed.data.categoryId : null,
    p_description: parsed.data.description,
    p_amount: parsed.data.amount,
    p_expense_date: parsed.data.expenseDate,
    p_paid_from: parsed.data.paidFrom,
    p_payment_reference: parsed.data.paymentReference || null,
    p_note: parsed.data.note || null,
  });

  if (error) {
    console.error("recordExpense: rpc failed", error);
    const message = expenseErrorMessage(error);
    // A future date is the one refusal that belongs on a specific field —
    // the user can see which one to change.
    if (message && message.includes("future")) {
      return { error: message, fieldErrors: { expenseDate: "This date hasn't happened yet." } };
    }
    return { error: message ?? "Couldn't record the expense. Please try again." };
  }

  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  redirect("/expenses");
}

export async function voidExpense(expenseId: string, _prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = voidExpenseSchema.safeParse({ reason: formData.get("reason") });

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  try {
    const businessId = await getCurrentBusinessId(supabase);
    await requirePermission(supabase, businessId, PERMISSIONS.EXPENSES_APPROVE);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("voidExpense: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { error } = await supabase.rpc("void_expense", {
    p_expense_id: expenseId,
    p_reason: parsed.data.reason,
  });

  if (error) {
    console.error("voidExpense: rpc failed", error);
    return { error: expenseErrorMessage(error) ?? "Couldn't void the expense. Please try again." };
  }

  revalidatePath("/expenses");
  revalidatePath(`/expenses/${expenseId}`);
  revalidatePath("/dashboard");
  return {};
}