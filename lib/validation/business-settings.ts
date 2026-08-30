import { z } from "zod";

/**
 * Validation + shape-conversion for the business profile (businesses
 * table) and business settings (business_settings table, Section 3's
 * jsonb groups) forms â€” Phase 4. Same pattern as lib/validation/auth.ts:
 * the Server Action re-validates this server-side; the client copy is
 * only for fast feedback.
 *
 * currency_code and country_code are deliberately NOT editable here â€”
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
 * Form shape. Rate fields are percentages (0â€“100, what a human types) â€”
 * the DB stores them as decimals (0â€“1), converted at the boundary by
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
