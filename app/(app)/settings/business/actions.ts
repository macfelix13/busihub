"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import {
  businessProfileSchema,
  businessSettingsSchema,
  settingsInputToJsonGroups,
} from "@/lib/validation/business-settings";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";
import { getCurrentBusinessId } from "@/lib/auth/current-business";

export interface SettingsFormState {
  error?: string;
  success?: boolean;
  fieldErrors?: Record<string, string>;
}

async function requireBusinessManager(supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>) {
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, PERMISSIONS.BUSINESS_MANAGE);
  return businessId;
}

export async function updateBusinessProfile(
  _prevState: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  const parsed = businessProfileSchema.safeParse({
    name: formData.get("name"),
    businessType: formData.get("businessType"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    addressLine1: formData.get("addressLine1"),
    addressLine2: formData.get("addressLine2"),
    city: formData.get("city"),
    region: formData.get("region"),
  });

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireBusinessManager(supabase);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { error: err.message };
    }
    console.error("updateBusinessProfile: permission lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { name, businessType, email, phone, addressLine1, addressLine2, city, region } = parsed.data;

  const { error } = await supabase
    .from("businesses")
    .update({
      name,
      business_type: businessType || null,
      email: email || null,
      phone: phone || null,
      address_line1: addressLine1 || null,
      address_line2: addressLine2 || null,
      city: city || null,
      region: region || null,
    })
    .eq("id", businessId);

  if (error) {
    console.error("updateBusinessProfile: update failed", error);
    return { error: "Couldn't save changes. Please try again." };
  }

  revalidatePath("/settings/business");
  return { success: true };
}

function businessSettingsFormValues(formData: FormData) {
  const checked = (name: string) => formData.get(name) === "on";
  return {
    vatEnabled: checked("vatEnabled"),
    vatRatePercent: formData.get("vatRatePercent"),
    vatInclusive: checked("vatInclusive"),
    nhilLevyRatePercent: formData.get("nhilLevyRatePercent"),
    getfundLevyRatePercent: formData.get("getfundLevyRatePercent"),
    covidLevyRatePercent: formData.get("covidLevyRatePercent"),

    receiptFooterMessage: formData.get("receiptFooterMessage"),
    receiptShowLogo: checked("receiptShowLogo"),
    receiptShowQrCode: checked("receiptShowQrCode"),
    receiptPaperSize: formData.get("receiptPaperSize"),

    invoicePrefix: formData.get("invoicePrefix"),
    invoiceNextNumber: formData.get("invoiceNextNumber"),
    invoiceDueDays: formData.get("invoiceDueDays"),

    posAllowNegativeStock: checked("posAllowNegativeStock"),
    posRequireCustomerForSale: checked("posRequireCustomerForSale"),
    posDefaultDiscountCapPercent: formData.get("posDefaultDiscountCapPercent"),

    inventoryLowStockThreshold: formData.get("inventoryLowStockThreshold"),
    inventoryTrackExpiry: checked("inventoryTrackExpiry"),
    inventoryTrackBatches: checked("inventoryTrackBatches"),

    notifyLowStockAlerts: checked("notifyLowStockAlerts"),
    notifyDailySummary: checked("notifyDailySummary"),

    appearanceTheme: formData.get("appearanceTheme"),
    appearancePrimaryColor: formData.get("appearancePrimaryColor"),
  };
}

export async function updateBusinessSettings(
  _prevState: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  const parsed = businessSettingsSchema.safeParse(businessSettingsFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireBusinessManager(supabase);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { error: err.message };
    }
    console.error("updateBusinessSettings: permission lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { error } = await supabase
    .from("business_settings")
    .update(settingsInputToJsonGroups(parsed.data))
    .eq("business_id", businessId);

  if (error) {
    console.error("updateBusinessSettings: update failed", error);
    return { error: "Couldn't save changes. Please try again." };
  }

  revalidatePath("/settings/business");
  return { success: true };
}

