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

export const receiveStockSchema = z.object({
  branchId: branchIdSchema,
  variantId: variantIdSchema,
  quantity: positiveQuantity,
  note: noteSchema,
});

export type ReceiveStockInput = z.infer<typeof receiveStockSchema>;

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
