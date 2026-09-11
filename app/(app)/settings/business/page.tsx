import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { jsonGroupsToFormDefaults, type BusinessSettingsRow } from "@/lib/validation/business-settings";
import { BusinessProfileForm } from "./business-profile-form";
import { BusinessSettingsForm } from "./business-settings-form";

export const metadata = { title: "Business settings" };

export default async function BusinessSettingsPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.BUSINESS_MANAGE);

  // The whole page is Owner-only (business.manage isn't in any other
  // seeded role's permission set — supabase/migrations/0011). Cosmetic —
  // both Server Actions re-check this regardless.
  if (!canManage) {
    redirect("/dashboard");
  }

  const [{ data: business, error: businessError }, { data: settings, error: settingsError }] = await Promise.all([
    supabase
      .from("businesses")
      .select("name, business_type, email, phone, address_line1, address_line2, city, region, country_code, currency_code")
      .eq("id", businessId)
      .maybeSingle(),
    supabase
      .from("business_settings")
      .select(
        "tax_settings, receipt_settings, invoice_settings, pos_settings, inventory_settings, notification_settings, appearance_settings"
      )
      .eq("business_id", businessId)
      .maybeSingle(),
  ]);

  if (businessError || settingsError) {
    console.error("BusinessSettingsPage: query failed", { businessError, settingsError });
  }

  if (!business) {
    // Shouldn't happen — every business row from register_business() has
    // one — but the (app) layout only guarantees a profile exists, not
    // that every downstream read succeeds.
    return (
      <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
        Couldn&apos;t load your business. Please refresh the page.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Business settings</h1>
        <p className="text-neutral-500 dark:text-ink-muted">Your business profile and configurable defaults.</p>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card">
        <BusinessProfileForm
          defaultValues={{
            name: business.name,
            businessType: business.business_type ?? "",
            email: business.email ?? "",
            phone: business.phone ?? "",
            addressLine1: business.address_line1 ?? "",
            addressLine2: business.address_line2 ?? "",
            city: business.city ?? "",
            region: business.region ?? "",
          }}
        />
        <p className="mt-4 text-sm text-neutral-500 dark:text-ink-muted">
          Country ({business.country_code}) and currency ({business.currency_code}) are set at registration and can&apos;t be
          changed here — every price and tax calculation in Busihub assumes they stay fixed.
        </p>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card">
        <BusinessSettingsForm defaultValues={jsonGroupsToFormDefaults((settings ?? {}) as Partial<BusinessSettingsRow>)} />
      </div>
    </div>
  );
}
