import { z } from "zod";
import { decimalField } from "./numeric";

/**
 * Shared client+server validation for product/variant create+edit forms
 * (Phase 5). Same rationale as lib/validation/branches.ts: the Server
 * Action re-validates this, the client is never trusted on its own.
 */

export const UNITS_OF_MEASURE = [
  { value: "each", label: "Each" },
  { value: "kg", label: "Kilogram (kg)" },
  { value: "g", label: "Gram (g)" },
  { value: "litre", label: "Litre" },
  { value: "ml", label: "Millilitre (ml)" },
  { value: "box", label: "Box" },
  { value: "pack", label: "Pack" },
  { value: "dozen", label: "Dozen" },
  { value: "bag", label: "Bag" },
  { value: "carton", label: "Carton" },
  { value: "meter", label: "Meter" },
  { value: "set", label: "Set" },
] as const;

const UNIT_VALUES = UNITS_OF_MEASURE.map((u) => u.value) as [string, ...string[]];

export const TAX_CATEGORIES = [
  { value: "standard", label: "Standard-rated" },
  { value: "zero_rated", label: "Zero-rated" },
  { value: "exempt", label: "VAT-exempt" },
] as const;

const TAX_CATEGORY_VALUES = TAX_CATEGORIES.map((c) => c.value) as [string, ...string[]];

const optionalTrimmed = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

export const productDetailsSchema = z.object({
  name: z.string().trim().min(1, "Product name is required").max(200),
  description: optionalTrimmed(2000),
  category: optionalTrimmed(100),
  unitOfMeasure: z.enum(UNIT_VALUES),
  taxCategory: z.enum(TAX_CATEGORY_VALUES),
});

export type ProductDetailsInput = z.infer<typeof productDetailsSchema>;

// SKU is optional (0014 — not every business assigns one to every item),
// same shape as barcode: trimmed, capped at 64 chars, blank is allowed.
const skuSchema = optionalTrimmed(64);
const barcodeSchema = optionalTrimmed(64);
// Percent-free decimal amount (see lib/money/money.ts — this is the
// major-unit decimal a numeric(14,2) column stores; conversion to integer
// minor units happens only where arithmetic is done, e.g. the POS/sales
// phase, not here).
//
// decimalField() rather than z.coerce.number(): the latter is
// Number(input) underneath, and Number("") is 0, so a selling price the
// user left blank parsed as a deliberate zero and created a product that
// was free. See lib/validation/numeric.ts.
const moneyAmount = (requiredMessage: string) =>
  decimalField({ decimals: 2, requiredMessage, invalidMessage: "Enter a number" }).refine((n) => n >= 0, {
    message: "Must be zero or more",
  });

const sellingPriceSchema = moneyAmount("Enter a selling price");

// Cost price genuinely is optional — plenty of small shops don't track
// it — so blank means zero here, deliberately and in one visible place,
// rather than by accident everywhere.
const costPriceSchema = z.preprocess(
  (v) => (v === null || v === undefined || (typeof v === "string" && v.trim().length === 0) ? "0" : v),
  moneyAmount("Enter a cost price")
);

/**
 * One row of the variant-rows editor. variantOptions keys must exactly
 * match the product's variantOptionNames (checked in the schemas below,
 * since a lone variant has no product context to check against). Values
 * are intentionally NOT required here (no .min(1)) even though an empty
 * one is invalid — validateVariantOptionKeys() below is the sole place
 * that flags a missing/empty option value, so there's exactly one error
 * path/message for it. Chaining .min(1) here too would let Zod's own
 * per-value check fail first, which (per Zod's refinement semantics)
 * skips the superRefine below entirely and raises its error at a nested
 * path ("variants.0.variantOptions.Size") the form never looks up —
 * silently swallowing the message instead of showing it. Caught by
 * tracing through exactly this "leave an option blank" path, not assumed.
 */
/**
 * What is already on the shelf when the product is first added. Blank
 * means none — the overwhelmingly common case for a product being set up
 * before it arrives — so it is preprocessed to "0" rather than being a
 * required field. Three decimals because a product may be weighed.
 */
const openingStockSchema = z.preprocess(
  (v) => (v === null || v === undefined || (typeof v === "string" && v.trim().length === 0) ? "0" : v),
  decimalField({ decimals: 3, requiredMessage: "Enter a quantity", invalidMessage: "Enter a number" }).refine(
    (n) => n >= 0,
    { message: "Cannot be negative" }
  )
);

export const variantRowSchema = z.object({
  sku: skuSchema,
  barcode: barcodeSchema,
  variantOptions: z.record(z.string(), z.string().trim()).default({}),
  costPrice: costPriceSchema,
  sellingPrice: sellingPriceSchema,
  openingStock: openingStockSchema,
});

export type VariantRowInput = z.infer<typeof variantRowSchema>;

function validateVariantOptionKeys(
  variants: VariantRowInput[],
  optionNames: string[],
  ctx: z.RefinementCtx,
  path: (index: number) => (string | number)[]
) {
  const expected = new Set(optionNames);
  variants.forEach((variant, index) => {
    const keys = Object.keys(variant.variantOptions);
    const missing = optionNames.filter((name) => !variant.variantOptions[name]?.trim());
    const extra = keys.filter((key) => !expected.has(key));
    if (missing.length > 0 || extra.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          optionNames.length > 0
            ? `Set a value for: ${optionNames.join(", ")}`
            : "This product has no variant options — leave these blank.",
        path: path(index),
      });
    }
  });
}

function validateNoDuplicates(variants: VariantRowInput[], ctx: z.RefinementCtx, path: (index: number, field: "sku" | "barcode") => (string | number)[]) {
  const seenSkus = new Map<string, number>();
  const seenBarcodes = new Map<string, number>();
  variants.forEach((variant, index) => {
    // sku is optional (0014) — multiple blank SKUs in one submission are
    // fine (they all become NULL, and NULL never collides with itself in
    // Postgres either), so only check duplicates when a SKU was actually
    // given, same as barcode already does below.
    if (variant.sku) {
      const skuKey = variant.sku.toLowerCase();
      if (seenSkus.has(skuKey)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate SKU in this submission.", path: path(index, "sku") });
      }
      seenSkus.set(skuKey, index);
    }

    if (variant.barcode) {
      const barcodeKey = variant.barcode.toLowerCase();
      if (seenBarcodes.has(barcodeKey)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate barcode in this submission.", path: path(index, "barcode") });
      }
      seenBarcodes.set(barcodeKey, index);
    }
  });
}

/**
 * A service (braiding, sewing, barbering...) is a product with
 * type = 'service' — same catalog row shape, same variants, same
 * permissions (products.*, per the decision recorded in migration
 * 0040's header) — it just never carries stock and its sale lines
 * require a rendered_by. Defaults to "product" so every pre-existing
 * caller/form that doesn't know about this field keeps working exactly
 * as before.
 */
export const productTypeSchema = z.enum(["product", "service"]);

/** Full create-product form: product details + variant axis names + >=1 starting variant. */
export const createProductSchema = productDetailsSchema
  .extend({
    type: productTypeSchema.default("product"),
    variantOptionNames: z.array(z.string().trim().min(1).max(40)).max(3).default([]),
    variants: z.array(variantRowSchema).min(1, "At least one variant is required").max(200),
    /** Where any opening stock lands. Only required if some is given. */
    branchId: z.union([z.literal(""), z.string().uuid()]).optional(),
  })
  .superRefine((data, ctx) => {
    validateVariantOptionKeys(data.variants, data.variantOptionNames, ctx, (i) => ["variants", i, "variantOptions"]);
    validateNoDuplicates(data.variants, ctx, (i, field) => ["variants", i, field]);

    // create_product refuses this too. Catching it here means the message
    // names the branch box rather than arriving as a rejected product
    // with a form full of typing to redo. A service never carries stock —
    // create_product ignores opening_stock entirely for type='service' —
    // so this check doesn't apply to one, even if a stray value is present.
    if (data.type !== "service" && data.variants.some((v) => v.openingStock > 0) && !data.branchId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose which branch this stock is at.",
        path: ["branchId"],
      });
    }
  });

export type CreateProductInput = z.infer<typeof createProductSchema>;

/** Add-variant / edit-variant form for a single row against a known product (option names come from the product, not the form). */
export function variantFormSchema(optionNames: string[]) {
  return variantRowSchema.superRefine((data, ctx) => {
    validateVariantOptionKeys([data], optionNames, ctx, () => ["variantOptions"]);
  });
}

export const productStatusSchema = z.enum(["active", "archived"]);