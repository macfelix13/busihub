import { z } from "zod";
import { decimalField } from "./numeric";

/**
 * Shared client+server validation for the inventory forms (Phase 6).
 * Same rationale as lib/validation/products.ts: the Server Action
 * re-validates all of this, the client is never trusted on its own.
 */

/**
 * Why a stock movement has a reason: the ledger is the audit trail, and
 * "someone changed it to 7" is not an audit trail. Receiving is its own
 * reason (and its own permission); everything else is an adjustment that
 * has to say why.
 *
 * These are the *user-facing* adjustment reasons — they're stored in
 * inventory_movements.note alongside reason = 'adjustment', rather than
 * as distinct reason values, so that adding "expired" later is a change
 * to this list and not a database migration plus an RLS policy edit.
 */
export const ADJUSTMENT_REASONS = [
  { value: "damaged", label: "Damaged" },
  { value: "expired", label: "Expired / spoiled" },
  { value: "lost", label: "Lost or stolen" },
  { value: "returned_to_supplier", label: "Returned to supplier" },
  { value: "correction", label: "Correcting a mistake" },
  { value: "other", label: "Other" },
] as const;

const ADJUSTMENT_REASON_VALUES = ADJUSTMENT_REASONS.map((r) => r.value) as [string, ...string[]];

export function adjustmentReasonLabel(value: string): string {
  return ADJUSTMENT_REASONS.find((r) => r.value === value)?.label ?? value;
}

/**
 * Quantities are numeric(14,3) in the database, not integers: products
 * carry a unit_of_measure and some are weighed (kg, litres) rather than
 * counted.
 *
 * decimalField() rather than z.coerce.number() specifically because a
 * blank field must NOT parse as zero here — for a stock count that would
 * silently wipe the item's stock. See lib/validation/numeric.ts.
 */
const quantitySchema = decimalField({
  decimals: 3,
  requiredMessage: "Enter a quantity",
  invalidMessage: "Enter a number",
});

const positiveQuantity = quantitySchema.refine((n) => n > 0, { message: "Enter a quantity greater than zero" });

const variantIdSchema = z.string().uuid("Choose a product");
const branchIdSchema = z.string().uuid("Choose a branch");
const noteSchema = z.string().trim().max(500).optional().or(z.literal(""));

/**
 * A `YYYY-MM-DD` string from a date input, and nothing else — same
 * pattern as lib/validation/expenses.ts's own dateField, duplicated
 * rather than imported (each validation file in this codebase is
 * self-contained; see e.g. categories.ts/products.ts). Real calendar
 * validation, not just a regex: rejects 2026-02-31, which a regex alone
 * would pass and `new Date(...)` would otherwise silently roll into
 * March.
 */
const expiryDateField = z
  .string({ errorMap: () => ({ message: "Choose a date" }) })
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === (month ?? 1) - 1 &&
      date.getUTCDate() === day
    );
  }, "That date doesn't exist");

export const receiveStockSchema = z.object({
  branchId: branchIdSchema,
  variantId: variantIdSchema,
  quantity: positiveQuantity,
  note: noteSchema,
  // Optional: the form only shows this field (and a caller only fills it
  // in) when the business has inventory_settings.track_expiry on — see
  // migration 0055's header for why expiry dates are logged separately
  // from the stock movement itself rather than as a new column here.
  expiryDate: expiryDateField.optional().or(z.literal("")),
});

export type ReceiveStockInput = z.infer<typeof receiveStockSchema>;

/**
 * Logging an expiry date for stock already on hand — either right after
 * receiving it, or backfilling for stock that arrived before the
 * business turned expiry tracking on. Unlike receiveStockSchema's
 * optional expiryDate, this one is required: the whole point of this
 * form is to record a date.
 */
export const addExpiryBatchSchema = z.object({
  branchId: branchIdSchema,
  variantId: variantIdSchema,
  quantity: positiveQuantity,
  expiryDate: expiryDateField,
  note: noteSchema,
});

export type AddExpiryBatchInput = z.infer<typeof addExpiryBatchSchema>;

/**
 * An adjustment's quantity is entered as a positive number plus a
 * direction, rather than as a signed number. Typing "-3" into a box is a
 * well-known way to fat-finger "+3", and the direction is a decision the
 * user should make explicitly.
 */
export const adjustStockSchema = z.object({
  branchId: branchIdSchema,
  variantId: variantIdSchema,
  direction: z.enum(["decrease", "increase"]),
  quantity: positiveQuantity,
  reason: z.enum(ADJUSTMENT_REASON_VALUES),
  note: noteSchema,
});

export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

/** A stock count is absolute: "there are N on the shelf". Zero is valid — that's the whole point of counting. */
export const stockCountSchema = z.object({
  branchId: branchIdSchema,
  variantId: variantIdSchema,
  countedQuantity: quantitySchema.refine((n) => n >= 0, { message: "Must be zero or more" }),
  note: noteSchema,
});

export type StockCountInput = z.infer<typeof stockCountSchema>;

/**
 * Display helper: trims the trailing zeros a numeric(14,3) always carries
 * ("15.000" → "15", "2.500" → "2.5") so a shop counting whole bags of
 * rice doesn't read three meaningless decimals on every row.
 */
export function formatQuantity(value: number | string): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "0";
  return String(Number(n.toFixed(3)));
}