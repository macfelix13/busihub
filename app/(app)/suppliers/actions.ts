"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { supplierSchema, supplierStatusSchema } from "@/lib/validation/purchasing";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

type SupabaseServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

async function requireSupplierPermission(supabase: SupabaseServerClient, permission: PermissionKey) {
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, permission);
  return businessId;
}

function supplierFormValues(formData: FormData) {
  return {
    name: formData.get("name"),
    contactName: formData.get("contactName"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    address: formData.get("address"),
    paymentTerms: formData.get("paymentTerms"),
    notes: formData.get("notes"),
  };
}

function supplierRow(data: {
  name: string;
  contactName?: string;
  phone?: string;
  email?: string;
  address?: string;
  paymentTerms?: string;
  notes?: string;
}) {
  return {
    name: data.name,
    contact_name: data.contactName || null,
    phone: data.phone || null,
    email: data.email || null,
    address: data.address || null,
    payment_terms: data.paymentTerms || null,
    notes: data.notes || null,
  };
}

/** unique (business_id, name) is the only unique constraint on suppliers. */
function duplicateName(error: { code?: string }): boolean {
  return error.code === "23505";
}

export async function createSupplier(_prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = supplierSchema.safeParse(supplierFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireSupplierPermission(supabase, PERMISSIONS.SUPPLIERS_MANAGE);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("createSupplier: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { error } = await supabase
    .from("suppliers")
    .insert({ ...supplierRow(parsed.data), business_id: businessId });

  if (error) {
    console.error("createSupplier: insert failed", error);
    if (duplicateName(error)) {
      return { error: "A supplier with this name already exists.", fieldErrors: { name: "This name is already used." } };
    }
    return { error: "Couldn't create the supplier. Please try again." };
  }

  revalidatePath("/suppliers");
  redirect("/suppliers");
}

export async function updateSupplier(supplierId: string, _prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = supplierSchema.safeParse(supplierFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireSupplierPermission(supabase, PERMISSIONS.SUPPLIERS_MANAGE);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("updateSupplier: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { error } = await supabase
    .from("suppliers")
    .update(supplierRow(parsed.data))
    // business_id filter is belt-and-suspenders beyond RLS (Section 49).
    .eq("id", supplierId)
    .eq("business_id", businessId);

  if (error) {
    console.error("updateSupplier: update failed", error);
    if (duplicateName(error)) {
      return { error: "A supplier with this name already exists.", fieldErrors: { name: "This name is already used." } };
    }
    return { error: "Couldn't save changes. Please try again." };
  }

  revalidatePath("/suppliers");
  revalidatePath(`/suppliers/${supplierId}`);
  redirect(`/suppliers/${supplierId}`);
}

/** Bound to a supplier id and target status; the button is only rendered for a caller who already has suppliers.manage. */
export async function setSupplierStatus(supplierId: string, status: "active" | "archived"): Promise<void> {
  const parsedStatus = supplierStatusSchema.parse(status);
  const supabase = await createServerSupabaseClient();
  const businessId = await requireSupplierPermission(supabase, PERMISSIONS.SUPPLIERS_MANAGE);

  const { error } = await supabase
    .from("suppliers")
    .update({ status: parsedStatus })
    .eq("id", supplierId)
    .eq("business_id", businessId);

  if (error) {
    console.error("setSupplierStatus: update failed", error);
    throw new Error("Couldn't update the supplier. Please try again.");
  }

  revalidatePath("/suppliers");
  revalidatePath(`/suppliers/${supplierId}`);
}
