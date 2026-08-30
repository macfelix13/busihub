"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import {
  customerSchema,
  customerStatusSchema,
  customerPaymentSchema,
  customerChargeSchema,
} from "@/lib/validation/customers";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

type SupabaseServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

async function requireCustomerPermission(supabase: SupabaseServerClient, permission: PermissionKey) {
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, permission);
  return businessId;
}

/**
 * The database enforces the account rules itself (migration 0017) and
 * raises messages written for a person — the credit-limit one names the
 * customer and both figures, which is exactly what the user needs. Those
 * are surfaced; anything unrecognized stays generic.
 */
function accountErrorMessage(error: { code?: string; message?: string } | null): string | null {
  if (!error) return null;

  if (error.code === "23505") {
    return "Another customer already has this phone number.";
  }
  if (error.code === "P0001" && error.message) {
    if (error.message.includes("credit limit")) {
      // Passed through: it names the customer, the resulting balance and
      // the limit, all of which the user needs to decide what to do.
      return error.message;
    }
    if (error.message.includes("different businesses")) {
      return "That branch isn't available for this customer.";
    }
  }
  if (error.code === "22023" && (error.message ?? "").includes("payment must be more than zero")) {
    return "Enter a payment amount greater than zero.";
  }
  if (error.code === "P0002") {
    return "That customer or branch could not be found.";
  }
  if (error.code === "42501") {
    return "You don't have permission to do that.";
  }
  return null;
}

function customerFormValues(formData: FormData) {
  return {
    name: formData.get("name"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    address: formData.get("address"),
    notes: formData.get("notes"),
    creditLimit: formData.get("creditLimit"),
  };
}

function customerRow(data: {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  creditLimit: number;
}) {
  return {
    name: data.name,
    phone: data.phone || null,
    email: data.email || null,
    address: data.address || null,
    notes: data.notes || null,
    credit_limit: data.creditLimit,
  };
}

export async function createCustomer(_prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = customerSchema.safeParse(customerFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireCustomerPermission(supabase, PERMISSIONS.CUSTOMERS_EDIT);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("createCustomer: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { error } = await supabase
    .from("customers")
    .insert({ ...customerRow(parsed.data), business_id: businessId });

  if (error) {
    console.error("createCustomer: insert failed", error);
    const message = accountErrorMessage(error);
    if (error.code === "23505") {
      return { error: message ?? "", fieldErrors: { phone: "This phone number is already on another customer." } };
    }
    return { error: message ?? "Couldn't create the customer. Please try again." };
  }

  revalidatePath("/customers");
  redirect("/customers");
}

export async function updateCustomer(customerId: string, _prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = customerSchema.safeParse(customerFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireCustomerPermission(supabase, PERMISSIONS.CUSTOMERS_EDIT);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("updateCustomer: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { error } = await supabase
    .from("customers")
    .update(customerRow(parsed.data))
    // business_id filter is belt-and-suspenders beyond RLS (Section 49).
    .eq("id", customerId)
    .eq("business_id", businessId);

  if (error) {
    console.error("updateCustomer: update failed", error);
    const message = accountErrorMessage(error);
    if (error.code === "23505") {
      return { error: message ?? "", fieldErrors: { phone: "This phone number is already on another customer." } };
    }
    return { error: message ?? "Couldn't save changes. Please try again." };
  }

  revalidatePath("/customers");
  revalidatePath(`/customers/${customerId}`);
  redirect(`/customers/${customerId}`);
}

/** Bound to a customer id and target status; only rendered for a caller who already has customers.edit. */
export async function setCustomerStatus(customerId: string, status: "active" | "archived"): Promise<void> {
  const parsedStatus = customerStatusSchema.parse(status);
  const supabase = await createServerSupabaseClient();
  const businessId = await requireCustomerPermission(supabase, PERMISSIONS.CUSTOMERS_EDIT);

  const { error } = await supabase
    .from("customers")
    .update({ status: parsedStatus })
    .eq("id", customerId)
    .eq("business_id", businessId);

  if (error) {
    console.error("setCustomerStatus: update failed", error);
    throw new Error("Couldn't update the customer. Please try again.");
  }

  revalidatePath("/customers");
  revalidatePath(`/customers/${customerId}`);
}

export async function recordPayment(customerId: string, _prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = customerPaymentSchema.safeParse({
    amount: formData.get("amount"),
    branchId: formData.get("branchId"),
    note: formData.get("note"),
  });

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  try {
    await requireCustomerPermission(supabase, PERMISSIONS.CUSTOMERS_EDIT);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("recordPayment: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { amount, branchId, note } = parsed.data;

  // Via the RPC so the positive-in/negative-stored convention stays in one
  // place (migration 0017), rather than every caller remembering to negate.
  const { error } = await supabase.rpc("record_customer_payment", {
    p_customer_id: customerId,
    p_amount: amount,
    p_branch_id: branchId || null,
    p_note: note || null,
  });

  if (error) {
    console.error("recordPayment: rpc failed", error);
    return { error: accountErrorMessage(error) ?? "Couldn't record the payment. Please try again." };
  }

  revalidatePath(`/customers/${customerId}`);
  redirect(`/customers/${customerId}`);
}

export async function recordCharge(customerId: string, _prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = customerChargeSchema.safeParse({
    entryType: formData.get("entryType"),
    direction: formData.get("direction"),
    amount: formData.get("amount"),
    branchId: formData.get("branchId"),
    note: formData.get("note"),
  });

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  try {
    await requireCustomerPermission(supabase, PERMISSIONS.CUSTOMERS_EDIT);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("recordCharge: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { entryType, direction, amount, branchId, note } = parsed.data;
  // Positive = owes more, per the convention fixed in migration 0017.
  const signed = direction === "increase" ? amount : -amount;

  const { error } = await supabase.from("customer_account_entries").insert({
    customer_id: customerId,
    branch_id: branchId || null,
    amount: signed,
    entry_type: entryType,
    note: note || null,
  });

  if (error) {
    console.error("recordCharge: insert failed", error);
    return { error: accountErrorMessage(error) ?? "Couldn't record this entry. Please try again." };
  }

  revalidatePath(`/customers/${customerId}`);
  redirect(`/customers/${customerId}`);
}
