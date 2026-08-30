# Busihub Phase 4 -- creates/overwrites every file for branches + business settings.
# Run from F:\busihub in PowerShell: powershell -ExecutionPolicy Bypass -File apply-phase4.ps1
$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path "app\(app)" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "app\(app)\branches" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "app\(app)\branches\[id]\edit" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "app\(app)\branches\new" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "app\(app)\settings\business" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "components\ui" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "lib\auth" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "lib\validation" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "supabase\migrations" -ErrorAction SilentlyContinue | Out-Null

Write-Host "Writing components\ui\checkbox.tsx..."
@'
"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  description?: string;
}

/** Labeled checkbox for boolean settings toggles, styled to match Field/Select. */
export function Checkbox({ label, description, className, id, ...props }: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className={cn("flex items-start gap-3", className)}>
      <input
        id={inputId}
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0 rounded border-neutral-300 text-brand-600 focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900"
        {...props}
      />
      <label htmlFor={inputId} className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">{label}</span>
        {description ? (
          <span className="text-sm text-neutral-500 dark:text-neutral-400">{description}</span>
        ) : null}
      </label>
    </div>
  );
}
'@ | Set-Content -LiteralPath "components\ui\checkbox.tsx" -Encoding UTF8

Write-Host "Writing components\ui\select.tsx..."
@'
"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  label: string;
  error?: string;
  options: SelectOption[];
}

/** Labeled select, styled to match components/ui/field.tsx. */
export function Select({ label, error, className, id, options, ...props }: SelectProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
        {label}
      </label>
      <select
        id={inputId}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          "min-h-[44px] rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900",
          "focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30",
          "dark:border-neutral-700 dark:bg-neutral-900 dark:text-white",
          error && "border-red-500 focus:border-red-500 focus:ring-red-500/30",
          className
        )}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
'@ | Set-Content -LiteralPath "components\ui\select.tsx" -Encoding UTF8

Write-Host "Writing lib\auth\current-business.ts..."
@'
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Thrown when the caller has no session, or a session with no linked business (shouldn't happen past the (app) layout guard, but every Server Action here checks independently — never assumes a caller reached it "the normal way"). */
export class NoBusinessError extends Error {
  constructor() {
    super("This account is not linked to a business.");
    this.name = "NoBusinessError";
  }
}

/** Resolves the caller's own business_id via app_current_business_id() (supabase/migrations/0008) rather than a manual profiles query, so this stays in sync with the same function RLS policies use. */
export async function getCurrentBusinessId(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.rpc("app_current_business_id");

  if (error || !data) {
    throw new NoBusinessError();
  }

  return data as string;
}
'@ | Set-Content -LiteralPath "lib\auth\current-business.ts" -Encoding UTF8

Write-Host "Writing lib\validation\branches.ts..."
@'
import { z } from "zod";

/**
 * Shared client+server validation for branch create/edit forms (Phase 4).
 * Same rationale as lib/validation/auth.ts: the Server Action re-validates
 * this, the client never being trusted on its own.
 */
const optionalTrimmed = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal(""));

export const branchSchema = z.object({
  name: z.string().trim().min(1, "Branch name is required").max(120),
  addressLine1: optionalTrimmed(200),
  addressLine2: optionalTrimmed(200),
  city: optionalTrimmed(100),
  region: optionalTrimmed(100),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s-]{7,20}$/, "Enter a valid phone number")
    .optional()
    .or(z.literal("")),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address")
    .optional()
    .or(z.literal("")),
  timezone: z.string().trim().min(1, "Timezone is required").max(64),
  status: z.enum(["active", "inactive"]),
});

export type BranchInput = z.infer<typeof branchSchema>;

/** IANA timezones actually relevant to a Ghana-first POS — kept short and curated rather than the full ~400-entry IANA list, which would be a poor <select> experience for this audience. Extend as the business expands beyond Ghana. */
export const SUPPORTED_TIMEZONES = [
  "Africa/Accra",
  "Africa/Lagos",
  "Africa/Abidjan",
  "Africa/Nairobi",
  "Africa/Johannesburg",
  "Europe/London",
  "UTC",
] as const;
'@ | Set-Content -LiteralPath "lib\validation\branches.ts" -Encoding UTF8

Write-Host "Writing lib\validation\business-settings.ts..."
@'
import { z } from "zod";

/**
 * Validation + shape-conversion for the business profile (businesses
 * table) and business settings (business_settings table, Section 3's
 * jsonb groups) forms — Phase 4. Same pattern as lib/validation/auth.ts:
 * the Server Action re-validates this server-side; the client copy is
 * only for fast feedback.
 *
 * currency_code and country_code are deliberately NOT editable here —
 * every money calculation in lib/money and every Ghana-specific tax
 * default assumes the business's currency doesn't silently change after
 * registration. Changing it would need a dedicated, carefully-considered
 * migration flow, not a settings form field.
 */
export const businessProfileSchema = z.object({
  name: z.string().trim().min(2, "Business name must be at least 2 characters").max(120),
  businessType: z.string().trim().max(60).optional().or(z.literal("")),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").optional().or(z.literal("")),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s-]{7,20}$/, "Enter a valid phone number")
    .optional()
    .or(z.literal("")),
  addressLine1: z.string().trim().max(200).optional().or(z.literal("")),
  addressLine2: z.string().trim().max(200).optional().or(z.literal("")),
  city: z.string().trim().max(100).optional().or(z.literal("")),
  region: z.string().trim().max(100).optional().or(z.literal("")),
});

export type BusinessProfileInput = z.infer<typeof businessProfileSchema>;

const percent = (label: string) =>
  z.coerce
    .number({ invalid_type_error: `${label} must be a number` })
    .min(0, `${label} cannot be negative`)
    .max(100, `${label} cannot exceed 100%`);

/**
 * Form shape. Rate fields are percentages (0–100, what a human types) —
 * the DB stores them as decimals (0–1), converted at the boundary by
 * settingsInputToJsonGroups()/jsonGroupsToSettingsDefaults() below, never
 * inside the schema itself.
 */
export const businessSettingsSchema = z.object({
  // tax_settings
  vatEnabled: z.boolean(),
  vatRatePercent: percent("VAT rate"),
  vatInclusive: z.boolean(),
  nhilLevyRatePercent: percent("NHIL levy rate"),
  getfundLevyRatePercent: percent("GETFund levy rate"),
  covidLevyRatePercent: percent("COVID levy rate"),

  // receipt_settings
  receiptFooterMessage: z.string().trim().max(300),
  receiptShowLogo: z.boolean(),
  receiptShowQrCode: z.boolean(),
  receiptPaperSize: z.enum(["thermal_58mm", "thermal_80mm", "a4"]),

  // invoice_settings
  invoicePrefix: z.string().trim().min(1, "Invoice prefix is required").max(20),
  invoiceNextNumber: z.coerce.number().int("Must be a whole number").min(1, "Must be at least 1"),
  invoiceDueDays: z.coerce.number().int("Must be a whole number").min(0, "Cannot be negative").max(365),

  // pos_settings
  posAllowNegativeStock: z.boolean(),
  posRequireCustomerForSale: z.boolean(),
  posDefaultDiscountCapPercent: percent("Default discount cap"),

  // inventory_settings
  inventoryLowStockThreshold: z.coerce.number().int("Must be a whole number").min(0, "Cannot be negative"),
  inventoryTrackExpiry: z.boolean(),
  inventoryTrackBatches: z.boolean(),

  // notification_settings
  notifyLowStockAlerts: z.boolean(),
  notifyDailySummary: z.boolean(),

  // appearance_settings
  appearanceTheme: z.enum(["light", "dark", "system"]),
  appearancePrimaryColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Enter a valid hex color, e.g. #22a56d"),
});

export type BusinessSettingsInput = z.infer<typeof businessSettingsSchema>;

/** Shape of business_settings' jsonb columns as Supabase returns them (snake_case, decimals not percentages). Matches the defaults in supabase/migrations/0002_businesses.sql. */
export interface BusinessSettingsRow {
  tax_settings: {
    vat_enabled: boolean;
    vat_rate: number;
    vat_inclusive: boolean;
    nhil_levy_rate: number;
    getfund_levy_rate: number;
    covid_levy_rate: number;
  };
  receipt_settings: {
    footer_message: string;
    show_logo: boolean;
    show_qr_code: boolean;
    paper_size: "thermal_58mm" | "thermal_80mm" | "a4";
  };
  invoice_settings: {
    prefix: string;
    next_number: number;
    due_days: number;
  };
  pos_settings: {
    allow_negative_stock: boolean;
    require_customer_for_sale: boolean;
    default_discount_cap_percent: number;
  };
  inventory_settings: {
    low_stock_threshold: number;
    track_expiry: boolean;
    track_batches: boolean;
  };
  notification_settings: {
    low_stock_alerts: boolean;
    daily_summary: boolean;
  };
  appearance_settings: {
    theme: "light" | "dark" | "system";
    primary_color: string;
  };
}

/** Form input -> the 7 jsonb objects to write back to business_settings. */
export function settingsInputToJsonGroups(input: BusinessSettingsInput) {
  return {
    tax_settings: {
      vat_enabled: input.vatEnabled,
      vat_rate: input.vatRatePercent / 100,
      vat_inclusive: input.vatInclusive,
      nhil_levy_rate: input.nhilLevyRatePercent / 100,
      getfund_levy_rate: input.getfundLevyRatePercent / 100,
      covid_levy_rate: input.covidLevyRatePercent / 100,
    },
    receipt_settings: {
      footer_message: input.receiptFooterMessage,
      show_logo: input.receiptShowLogo,
      show_qr_code: input.receiptShowQrCode,
      paper_size: input.receiptPaperSize,
    },
    invoice_settings: {
      prefix: input.invoicePrefix,
      next_number: input.invoiceNextNumber,
      due_days: input.invoiceDueDays,
    },
    pos_settings: {
      allow_negative_stock: input.posAllowNegativeStock,
      require_customer_for_sale: input.posRequireCustomerForSale,
      default_discount_cap_percent: input.posDefaultDiscountCapPercent,
    },
    inventory_settings: {
      low_stock_threshold: input.inventoryLowStockThreshold,
      track_expiry: input.inventoryTrackExpiry,
      track_batches: input.inventoryTrackBatches,
    },
    notification_settings: {
      low_stock_alerts: input.notifyLowStockAlerts,
      daily_summary: input.notifyDailySummary,
    },
    appearance_settings: {
      theme: input.appearanceTheme,
      primary_color: input.appearancePrimaryColor,
    },
  };
}

/**
 * Stored row -> form default values, with fallbacks matching 0002's DB
 * defaults in case any key is ever missing (e.g. a row written before a
 * settings key existed). Percentages are the DB's decimals * 100.
 */
export function jsonGroupsToFormDefaults(row: Partial<BusinessSettingsRow>): BusinessSettingsInput {
  const tax = row.tax_settings ?? ({} as BusinessSettingsRow["tax_settings"]);
  const receipt = row.receipt_settings ?? ({} as BusinessSettingsRow["receipt_settings"]);
  const invoice = row.invoice_settings ?? ({} as BusinessSettingsRow["invoice_settings"]);
  const pos = row.pos_settings ?? ({} as BusinessSettingsRow["pos_settings"]);
  const inventory = row.inventory_settings ?? ({} as BusinessSettingsRow["inventory_settings"]);
  const notification = row.notification_settings ?? ({} as BusinessSettingsRow["notification_settings"]);
  const appearance = row.appearance_settings ?? ({} as BusinessSettingsRow["appearance_settings"]);

  return {
    vatEnabled: tax.vat_enabled ?? true,
    vatRatePercent: (tax.vat_rate ?? 0.15) * 100,
    vatInclusive: tax.vat_inclusive ?? true,
    nhilLevyRatePercent: (tax.nhil_levy_rate ?? 0.025) * 100,
    getfundLevyRatePercent: (tax.getfund_levy_rate ?? 0.025) * 100,
    covidLevyRatePercent: (tax.covid_levy_rate ?? 0.01) * 100,

    receiptFooterMessage: receipt.footer_message ?? "Thank you for your business!",
    receiptShowLogo: receipt.show_logo ?? true,
    receiptShowQrCode: receipt.show_qr_code ?? true,
    receiptPaperSize: receipt.paper_size ?? "thermal_80mm",

    invoicePrefix: invoice.prefix ?? "INV-",
    invoiceNextNumber: invoice.next_number ?? 1,
    invoiceDueDays: invoice.due_days ?? 14,

    posAllowNegativeStock: pos.allow_negative_stock ?? false,
    posRequireCustomerForSale: pos.require_customer_for_sale ?? false,
    posDefaultDiscountCapPercent: pos.default_discount_cap_percent ?? 5,

    inventoryLowStockThreshold: inventory.low_stock_threshold ?? 5,
    inventoryTrackExpiry: inventory.track_expiry ?? false,
    inventoryTrackBatches: inventory.track_batches ?? false,

    notifyLowStockAlerts: notification.low_stock_alerts ?? true,
    notifyDailySummary: notification.daily_summary ?? true,

    appearanceTheme: appearance.theme ?? "system",
    appearancePrimaryColor: appearance.primary_color ?? "#22a56d",
  };
}
'@ | Set-Content -LiteralPath "lib\validation\business-settings.ts" -Encoding UTF8

Write-Host "Writing lib\validation\zod-helpers.ts..."
@'
import type { ZodError } from "zod";

/** Flattens a ZodError into the { fieldName: message } shape every form-state action in this app returns (first issue per field wins). */
export function zodFieldErrors(error: ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}
'@ | Set-Content -LiteralPath "lib\validation\zod-helpers.ts" -Encoding UTF8

Write-Host "Writing supabase\migrations\0012_set_main_branch.sql..."
@'
-- Busihub — 0012: set_main_branch()
--
-- Exactly one branch per business can have is_main = true (partial unique
-- index, 0003). Swapping which branch is main is therefore two UPDATEs
-- that must happen atomically — a UI that did them as two separate
-- requests could crash between them (leaving zero main branches) or race
-- with a concurrent request. Wrapping both in one function makes it a
-- single statement from the caller's point of view; Postgres treats the
-- whole function body as one transaction, so either both UPDATEs apply or
-- neither does.
--
-- Deliberately NOT security definer: it runs with the calling user's own
-- privileges, so the existing branches_select/branches_update RLS
-- policies (0009) — which already require business_id =
-- app_current_business_id() and branches.manage — apply exactly as they
-- would to two ordinary UPDATE statements. No new authorization logic to
-- keep in sync with those policies. Application code should still call
-- requirePermission(..., 'branches.manage') first for a clean error
-- message (Section 49's defense-in-depth pattern); RLS is the backstop,
-- not the only check.
create or replace function set_main_branch(p_branch_id uuid)
returns void
language plpgsql
as $$
declare
  v_business_id uuid;
begin
  -- RLS-scoped: only resolves if the caller can see this branch at all.
  select business_id into v_business_id from branches where id = p_branch_id;

  if v_business_id is null then
    raise exception 'Branch not found' using errcode = 'P0002';
  end if;

  update branches set is_main = false
    where business_id = v_business_id and is_main and id <> p_branch_id;

  update branches set is_main = true
    where id = p_branch_id;
end;
$$;

comment on function set_main_branch is
  'Atomically swaps which branch is the main branch for its business. Runs as the caller (not security definer) so branches_update RLS (0009) governs it exactly as it would two ordinary UPDATEs.';

grant execute on function set_main_branch(uuid) to authenticated;
'@ | Set-Content -LiteralPath "supabase\migrations\0012_set_main_branch.sql" -Encoding UTF8

Write-Host "Writing app\(app)\layout.tsx..."
@'
import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { LogoutButton } from "@/components/logout-button";

/**
 * Every route under (app) requires a signed-in user with a linked
 * business profile. This is a convenience redirect for UX — the real
 * security boundary is RLS (every query below this layout is still
 * scoped by Postgres, not by this check) — but without it a
 * signed-out visitor would just see empty states instead of being sent
 * to /login, which is confusing rather than insecure.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    // businesses has two FKs to/from profiles (profiles.business_id ->
    // businesses.id, and businesses.created_by -> profiles.id), so the
    // embed must be disambiguated with the FK constraint name — a bare
    // `businesses (name)` is rejected by PostgREST with PGRST201
    // ("more than one relationship was found"). Confirmed against the
    // real schema; profiles_business_id_fkey is the one we want here.
    .select("id, first_name, last_name, business_id, businesses!profiles_business_id_fkey (name)")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    // A genuine query failure (RLS denial, PostgREST embed error, etc.)
    // looks identical to "no profile yet" if we only check `!profile` —
    // that swallowed real errors during testing and made this
    // undiagnosable. Log it distinctly so the two cases don't get
    // confused again.
    console.error("(app) layout: profiles query failed", profileError);
    redirect("/login");
  }

  if (!profile) {
    // Authenticated but no business/profile link yet (e.g. email
    // confirmation pending, or the register_business() RPC failed after
    // signUp — see app/(auth)/login/actions.ts). Nothing under (app) can
    // render sensibly without a business_id.
    redirect("/login");
  }

  const businessName = (profile as unknown as { businesses: { name: string } | null }).businesses?.name;

  // Cosmetic nav visibility only — every page/action behind these links
  // re-checks the same permission server-side (Section 49).
  const [canManageBranches, canManageBusiness] = await Promise.all([
    hasPermission(supabase, profile.business_id!, PERMISSIONS.BRANCHES_MANAGE),
    hasPermission(supabase, profile.business_id!, PERMISSIONS.BUSINESS_MANAGE),
  ]);

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="flex flex-col gap-3 border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-brand-600 px-2 py-1 text-sm font-bold text-white">B</span>
          <span className="font-semibold">{businessName ?? "Busihub"}</span>
        </div>
        <nav className="flex items-center gap-4 text-sm font-medium text-neutral-600 dark:text-neutral-300">
          <Link href="/dashboard" className="hover:text-neutral-900 dark:hover:text-white">
            Dashboard
          </Link>
          {canManageBranches ? (
            <Link href="/branches" className="hover:text-neutral-900 dark:hover:text-white">
              Branches
            </Link>
          ) : null}
          {canManageBusiness ? (
            <Link href="/settings/business" className="hover:text-neutral-900 dark:hover:text-white">
              Settings
            </Link>
          ) : null}
        </nav>
        <div className="flex items-center gap-4">
          <span className="hidden text-sm text-neutral-500 sm:inline">
            {profile.first_name} {profile.last_name}
          </span>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
'@ | Set-Content -LiteralPath "app\(app)\layout.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\branches\actions.ts..."
@'
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { branchSchema } from "@/lib/validation/branches";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";
import { getCurrentBusinessId } from "@/lib/auth/current-business";

export interface BranchFormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

function branchFormValues(formData: FormData) {
  return {
    name: formData.get("name"),
    addressLine1: formData.get("addressLine1"),
    addressLine2: formData.get("addressLine2"),
    city: formData.get("city"),
    region: formData.get("region"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    timezone: formData.get("timezone"),
    status: formData.get("status") ?? "active",
  };
}

/**
 * Resolves the caller's business_id and checks branches.manage. Shared by
 * every mutation below — the UI only ever shows these forms/buttons to a
 * user who already has this permission (see hasPermission() calls in the
 * pages), but that's cosmetic; this is the real, server-side check
 * (Section 49), with RLS underneath it as the final backstop either way.
 */
async function requireBranchManager(supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>) {
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, PERMISSIONS.BRANCHES_MANAGE);
  return businessId;
}

export async function createBranch(
  _prevState: BranchFormState,
  formData: FormData
): Promise<BranchFormState> {
  const parsed = branchSchema.safeParse(branchFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireBranchManager(supabase);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { error: err.message };
    }
    console.error("createBranch: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { name, addressLine1, addressLine2, city, region, phone, email, timezone, status } = parsed.data;

  const { error } = await supabase.from("branches").insert({
    business_id: businessId,
    name,
    address_line1: addressLine1 || null,
    address_line2: addressLine2 || null,
    city: city || null,
    region: region || null,
    phone: phone || null,
    email: email || null,
    timezone,
    status,
  });

  if (error) {
    console.error("createBranch: insert failed", error);
    // 23505 = unique_violation — branches(business_id, name) (0003).
    if (error.code === "23505") {
      return {
        error: "A branch with this name already exists.",
        fieldErrors: { name: "A branch with this name already exists." },
      };
    }
    return { error: "Couldn't create the branch. Please try again." };
  }

  revalidatePath("/branches");
  redirect("/branches");
}

export async function updateBranch(
  branchId: string,
  _prevState: BranchFormState,
  formData: FormData
): Promise<BranchFormState> {
  const parsed = branchSchema.safeParse(branchFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireBranchManager(supabase);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { error: err.message };
    }
    console.error("updateBranch: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { name, addressLine1, addressLine2, city, region, phone, email, timezone, status } = parsed.data;

  const { error } = await supabase
    .from("branches")
    .update({
      name,
      address_line1: addressLine1 || null,
      address_line2: addressLine2 || null,
      city: city || null,
      region: region || null,
      phone: phone || null,
      email: email || null,
      timezone,
      status,
    })
    // business_id filter is belt-and-suspenders — RLS already scopes this,
    // but an explicit filter means a wrong/forged branchId for another
    // tenant affects 0 rows instead of relying solely on RLS to notice.
    .eq("id", branchId)
    .eq("business_id", businessId);

  if (error) {
    console.error("updateBranch: update failed", error);
    if (error.code === "23505") {
      return {
        error: "A branch with this name already exists.",
        fieldErrors: { name: "A branch with this name already exists." },
      };
    }
    return { error: "Couldn't save changes. Please try again." };
  }

  revalidatePath("/branches");
  redirect("/branches");
}

/**
 * Bound to a specific branch id from the branches list page
 * (setMainBranch.bind(null, branch.id)) and used directly as a <form
 * action>, the same no-useFormState pattern as lib/auth/sign-out.ts. Lets
 * an AuthorizationError/NoBusinessError propagate to Next's default error
 * boundary rather than returning a form state — acceptable here because
 * the triggering button is itself only rendered for a user who already
 * has branches.manage (cosmetic check), so a thrown error here means
 * something changed permissions out from under them mid-session, not the
 * expected path.
 */
export async function setMainBranch(branchId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  await requireBranchManager(supabase);

  const { error } = await supabase.rpc("set_main_branch", { p_branch_id: branchId });

  if (error) {
    console.error("setMainBranch: rpc failed", error);
    throw new Error("Couldn't set this branch as main. Please try again.");
  }

  revalidatePath("/branches");
}
'@ | Set-Content -LiteralPath "app\(app)\branches\actions.ts" -Encoding UTF8

Write-Host "Writing app\(app)\branches\page.tsx..."
@'
import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { SetMainBranchButton } from "./set-main-branch-button";

export const metadata = { title: "Branches" };

export default async function BranchesPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.BRANCHES_MANAGE);

  // RLS-scoped — no explicit .eq("business_id", ...) needed (Section 4, Section 49).
  const { data: branches, error } = await supabase
    .from("branches")
    .select("id, name, is_main, city, region, phone, email, status")
    .order("is_main", { ascending: false })
    .order("name", { ascending: true });

  if (error) {
    console.error("BranchesPage: branches query failed", error);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Branches</h1>
          <p className="text-neutral-500">Locations your business operates from.</p>
        </div>
        {canManage ? (
          <Link href="/branches/new">
            <Button>Add branch</Button>
          </Link>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load branches. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {branches && branches.length > 0 ? (
              branches.map((branch) => (
                <li key={branch.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{branch.name}</span>
                      {branch.is_main ? (
                        <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-800 dark:bg-brand-900 dark:text-brand-200">
                          Main
                        </span>
                      ) : null}
                      {branch.status === "inactive" ? (
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                          Inactive
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-sm text-neutral-500">
                      {[branch.city, branch.region].filter(Boolean).join(", ") || "No location set"}
                      {branch.phone ? ` · ${branch.phone}` : ""}
                    </p>
                  </div>
                  {canManage ? (
                    <div className="flex items-center gap-2">
                      {!branch.is_main ? <SetMainBranchButton branchId={branch.id} /> : null}
                      <Link href={`/branches/${branch.id}/edit`}>
                        <Button variant="secondary">Edit</Button>
                      </Link>
                    </div>
                  ) : null}
                </li>
              ))
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500">No branches yet.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
'@ | Set-Content -LiteralPath "app\(app)\branches\page.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\branches\branch-form.tsx..."
@'
"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/button";
import { SUPPORTED_TIMEZONES, type BranchInput } from "@/lib/validation/branches";
import type { BranchFormState } from "./actions";

interface BranchFormProps {
  action: (prevState: BranchFormState, formData: FormData) => Promise<BranchFormState>;
  defaultValues?: Partial<BranchInput>;
  submitLabel: string;
  pendingLabel: string;
  showStatus?: boolean;
}

const initialState: BranchFormState = {};

/** Shared by app/(app)/branches/new and .../[id]/edit — same fields, different bound action. */
export function BranchForm({ action, defaultValues, submitLabel, pendingLabel, showStatus }: BranchFormProps) {
  const [state, formAction] = useFormState(action, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <Field
        label="Branch name"
        name="name"
        required
        defaultValue={defaultValues?.name}
        error={state.fieldErrors?.name}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Address line 1" name="addressLine1" defaultValue={defaultValues?.addressLine1} error={state.fieldErrors?.addressLine1} />
        <Field label="Address line 2" name="addressLine2" defaultValue={defaultValues?.addressLine2} error={state.fieldErrors?.addressLine2} />
        <Field label="City" name="city" defaultValue={defaultValues?.city} error={state.fieldErrors?.city} />
        <Field label="Region" name="region" defaultValue={defaultValues?.region} error={state.fieldErrors?.region} />
        <Field label="Phone" name="phone" type="tel" defaultValue={defaultValues?.phone} error={state.fieldErrors?.phone} />
        <Field label="Email" name="email" type="email" defaultValue={defaultValues?.email} error={state.fieldErrors?.email} />
      </div>

      <Select
        label="Timezone"
        name="timezone"
        defaultValue={defaultValues?.timezone ?? "Africa/Accra"}
        error={state.fieldErrors?.timezone}
        options={SUPPORTED_TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
      />

      {showStatus ? (
        <Select
          label="Status"
          name="status"
          defaultValue={defaultValues?.status ?? "active"}
          error={state.fieldErrors?.status}
          options={[
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ]}
        />
      ) : (
        <input type="hidden" name="status" value="active" />
      )}

      <SubmitButton pendingText={pendingLabel} className="mt-2 self-start px-6">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}
'@ | Set-Content -LiteralPath "app\(app)\branches\branch-form.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\branches\set-main-branch-button.tsx..."
@'
"use client";

import { setMainBranch } from "./actions";
import { SubmitButton } from "@/components/ui/button";

export function SetMainBranchButton({ branchId }: { branchId: string }) {
  return (
    <form action={setMainBranch.bind(null, branchId)}>
      <SubmitButton variant="ghost" pendingText="Setting…">
        Set as main
      </SubmitButton>
    </form>
  );
}
'@ | Set-Content -LiteralPath "app\(app)\branches\set-main-branch-button.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\branches\new\page.tsx..."
@'
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { BranchForm } from "../branch-form";
import { createBranch } from "../actions";

export const metadata = { title: "Add branch" };

export default async function NewBranchPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.BRANCHES_MANAGE);

  // Cosmetic — createBranch() re-checks this server-side regardless.
  if (!canManage) {
    redirect("/branches");
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Add branch</h1>
        <p className="text-neutral-500">New branches start active — deactivate one later from its Edit page if needed.</p>
      </div>
      <BranchForm
        action={createBranch}
        submitLabel="Create branch"
        pendingLabel="Creating…"
        defaultValues={{ timezone: "Africa/Accra" }}
      />
    </div>
  );
}
'@ | Set-Content -LiteralPath "app\(app)\branches\new\page.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\branches\[id]\edit\page.tsx..."
@'
import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { BranchForm } from "../../branch-form";
import { updateBranch } from "../../actions";

export const metadata = { title: "Edit branch" };

export default async function EditBranchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.BRANCHES_MANAGE);

  // Cosmetic — updateBranch() re-checks this server-side regardless.
  if (!canManage) {
    redirect("/branches");
  }

  // RLS-scoped: a branch id from another tenant simply won't be found here.
  const { data: branch, error } = await supabase
    .from("branches")
    .select("id, name, address_line1, address_line2, city, region, phone, email, timezone, status")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("EditBranchPage: branch query failed", error);
  }

  if (!branch) {
    notFound();
  }

  const boundUpdateBranch = updateBranch.bind(null, branch.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Edit branch</h1>
        <p className="text-neutral-500">{branch.name}</p>
      </div>
      <BranchForm
        action={boundUpdateBranch}
        submitLabel="Save changes"
        pendingLabel="Saving…"
        showStatus
        defaultValues={{
          name: branch.name,
          addressLine1: branch.address_line1 ?? "",
          addressLine2: branch.address_line2 ?? "",
          city: branch.city ?? "",
          region: branch.region ?? "",
          phone: branch.phone ?? "",
          email: branch.email ?? "",
          timezone: branch.timezone,
          status: branch.status,
        }}
      />
    </div>
  );
}
'@ | Set-Content -LiteralPath "app\(app)\branches\[id]\edit\page.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\settings\business\actions.ts..."
@'
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
'@ | Set-Content -LiteralPath "app\(app)\settings\business\actions.ts" -Encoding UTF8

Write-Host "Writing app\(app)\settings\business\page.tsx..."
@'
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
        <p className="text-neutral-500">Your business profile and configurable defaults.</p>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
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
        <p className="mt-4 text-sm text-neutral-500">
          Country ({business.country_code}) and currency ({business.currency_code}) are set at registration and can&apos;t be
          changed here — every price and tax calculation in Busihub assumes they stay fixed.
        </p>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <BusinessSettingsForm defaultValues={jsonGroupsToFormDefaults((settings ?? {}) as Partial<BusinessSettingsRow>)} />
      </div>
    </div>
  );
}
'@ | Set-Content -LiteralPath "app\(app)\settings\business\page.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\settings\business\business-profile-form.tsx..."
@'
"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/button";
import type { BusinessProfileInput } from "@/lib/validation/business-settings";
import { updateBusinessProfile, type SettingsFormState } from "./actions";

const initialState: SettingsFormState = {};

export function BusinessProfileForm({ defaultValues }: { defaultValues: BusinessProfileInput }) {
  const [state, formAction] = useFormState(updateBusinessProfile, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="rounded-xl bg-green-50 px-3.5 py-2.5 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          Saved.
        </p>
      ) : null}

      <Field label="Business name" name="name" required defaultValue={defaultValues.name} error={state.fieldErrors?.name} />
      <Field label="Business type" name="businessType" placeholder="e.g. Retail, Restaurant, Pharmacy" defaultValue={defaultValues.businessType} error={state.fieldErrors?.businessType} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Email" name="email" type="email" defaultValue={defaultValues.email} error={state.fieldErrors?.email} />
        <Field label="Phone" name="phone" type="tel" defaultValue={defaultValues.phone} error={state.fieldErrors?.phone} />
        <Field label="Address line 1" name="addressLine1" defaultValue={defaultValues.addressLine1} error={state.fieldErrors?.addressLine1} />
        <Field label="Address line 2" name="addressLine2" defaultValue={defaultValues.addressLine2} error={state.fieldErrors?.addressLine2} />
        <Field label="City" name="city" defaultValue={defaultValues.city} error={state.fieldErrors?.city} />
        <Field label="Region" name="region" defaultValue={defaultValues.region} error={state.fieldErrors?.region} />
      </div>

      <SubmitButton pendingText="Saving…" className="mt-2 self-start px-6">
        Save profile
      </SubmitButton>
    </form>
  );
}
'@ | Set-Content -LiteralPath "app\(app)\settings\business\business-profile-form.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\settings\business\business-settings-form.tsx..."
@'
"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/button";
import type { BusinessSettingsInput } from "@/lib/validation/business-settings";
import { updateBusinessSettings, type SettingsFormState } from "./actions";

const initialState: SettingsFormState = {};

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-neutral-200 pt-5 first:border-t-0 first:pt-0 dark:border-neutral-800">
      <h3 className="font-semibold">{title}</h3>
      {description ? <p className="mt-0.5 text-sm text-neutral-500">{description}</p> : null}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </div>
  );
}

export function BusinessSettingsForm({ defaultValues }: { defaultValues: BusinessSettingsInput }) {
  const [state, formAction] = useFormState(updateBusinessSettings, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="rounded-xl bg-green-50 px-3.5 py-2.5 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          Saved.
        </p>
      ) : null}

      <Section title="Tax" description="Ghana VAT and statutory levies applied at checkout (Section 26). Rates are percentages.">
        <Checkbox label="Charge VAT" name="vatEnabled" defaultChecked={defaultValues.vatEnabled} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="VAT rate (%)" name="vatRatePercent" type="number" step="0.01" min={0} max={100} defaultValue={defaultValues.vatRatePercent} error={state.fieldErrors?.vatRatePercent} />
          <Field label="NHIL levy (%)" name="nhilLevyRatePercent" type="number" step="0.01" min={0} max={100} defaultValue={defaultValues.nhilLevyRatePercent} error={state.fieldErrors?.nhilLevyRatePercent} />
          <Field label="GETFund levy (%)" name="getfundLevyRatePercent" type="number" step="0.01" min={0} max={100} defaultValue={defaultValues.getfundLevyRatePercent} error={state.fieldErrors?.getfundLevyRatePercent} />
          <Field label="COVID levy (%)" name="covidLevyRatePercent" type="number" step="0.01" min={0} max={100} defaultValue={defaultValues.covidLevyRatePercent} error={state.fieldErrors?.covidLevyRatePercent} />
        </div>
        <Checkbox
          label="Prices include VAT"
          description="If off, VAT is added on top of listed prices instead of already being part of them."
          name="vatInclusive"
          defaultChecked={defaultValues.vatInclusive}
        />
      </Section>

      <Section title="Receipts">
        <Field label="Receipt footer message" name="receiptFooterMessage" defaultValue={defaultValues.receiptFooterMessage} error={state.fieldErrors?.receiptFooterMessage} />
        <Select
          label="Paper size"
          name="receiptPaperSize"
          defaultValue={defaultValues.receiptPaperSize}
          error={state.fieldErrors?.receiptPaperSize}
          options={[
            { value: "thermal_58mm", label: "Thermal 58mm" },
            { value: "thermal_80mm", label: "Thermal 80mm" },
            { value: "a4", label: "A4" },
          ]}
        />
        <Checkbox label="Show logo on receipt" name="receiptShowLogo" defaultChecked={defaultValues.receiptShowLogo} />
        <Checkbox label="Show QR code on receipt" name="receiptShowQrCode" defaultChecked={defaultValues.receiptShowQrCode} />
      </Section>

      <Section title="Invoices">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Invoice prefix" name="invoicePrefix" defaultValue={defaultValues.invoicePrefix} error={state.fieldErrors?.invoicePrefix} />
          <Field label="Next invoice number" name="invoiceNextNumber" type="number" min={1} step={1} defaultValue={defaultValues.invoiceNextNumber} error={state.fieldErrors?.invoiceNextNumber} />
          <Field label="Payment due (days)" name="invoiceDueDays" type="number" min={0} step={1} defaultValue={defaultValues.invoiceDueDays} error={state.fieldErrors?.invoiceDueDays} />
        </div>
      </Section>

      <Section title="Point of sale">
        <Checkbox
          label="Allow sales when stock is negative"
          description="Off is safer for most shops — it stops a sale once stock hits zero."
          name="posAllowNegativeStock"
          defaultChecked={defaultValues.posAllowNegativeStock}
        />
        <Checkbox
          label="Require a customer on every sale"
          name="posRequireCustomerForSale"
          defaultChecked={defaultValues.posRequireCustomerForSale}
        />
        <Field
          label="Default discount cap (%)"
          name="posDefaultDiscountCapPercent"
          type="number"
          step="0.01"
          min={0}
          max={100}
          defaultValue={defaultValues.posDefaultDiscountCapPercent}
          error={state.fieldErrors?.posDefaultDiscountCapPercent}
        />
      </Section>

      <Section title="Inventory">
        <Field
          label="Low stock threshold"
          name="inventoryLowStockThreshold"
          type="number"
          min={0}
          step={1}
          defaultValue={defaultValues.inventoryLowStockThreshold}
          error={state.fieldErrors?.inventoryLowStockThreshold}
        />
        <Checkbox label="Track expiry dates" name="inventoryTrackExpiry" defaultChecked={defaultValues.inventoryTrackExpiry} />
        <Checkbox label="Track batches/lots" name="inventoryTrackBatches" defaultChecked={defaultValues.inventoryTrackBatches} />
      </Section>

      <Section title="Notifications">
        <Checkbox label="Low stock alerts" name="notifyLowStockAlerts" defaultChecked={defaultValues.notifyLowStockAlerts} />
        <Checkbox label="Daily summary" name="notifyDailySummary" defaultChecked={defaultValues.notifyDailySummary} />
      </Section>

      <Section title="Appearance">
        <Select
          label="Theme"
          name="appearanceTheme"
          defaultValue={defaultValues.appearanceTheme}
          error={state.fieldErrors?.appearanceTheme}
          options={[
            { value: "system", label: "Match device" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
        <Field
          label="Primary color"
          name="appearancePrimaryColor"
          type="color"
          defaultValue={defaultValues.appearancePrimaryColor}
          error={state.fieldErrors?.appearancePrimaryColor}
          className="h-11 w-20 cursor-pointer p-1"
        />
      </Section>

      <SubmitButton pendingText="Saving…" className="mt-2 self-start px-6">
        Save settings
      </SubmitButton>
    </form>
  );
}
'@ | Set-Content -LiteralPath "app\(app)\settings\business\business-settings-form.tsx" -Encoding UTF8

Write-Host "Done. All files written."