import { z } from "zod";
import { decimalField } from "./numeric";

/**
 * Shared client+server validation for suppliers and purchase orders
 * (Phase 7). The Server Action re-validates all of this; the client is
 * never trusted on its own.
 */

const optionalTrimmed = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

export const supplierSchema = z.object({
  name: z.string().trim().min(1, "Supplier name is required").max(200),
  contactName: optionalTrimmed(200),
  phone: optionalTrimmed(40),
  // Blank is allowed, but a value that IS given has to look like an email —
  // the column is citext with no format constraint, so this is the check.
  email: z.union([z.literal(""), z.string().trim().email("Enter a valid email address").max(255)]).optional(),
  address: optionalTrimmed(500),
  paymentTerms: optionalTrimmed(120),
  notes: optionalTrimmed(2000),
});

export type SupplierInput = z.infer<typeof supplierSchema>;

export const supplierStatusSchema = z.enum(["active", "archived"]);

/** Quantities are numeric(14,3); costs are numeric(14,2). Blank never means zero — see lib/validation/numeric.ts. */
const orderedQuantity = decimalField({
  decimals: 3,
  requiredMessage: "Enter a quantity",
  invalidMessage: "Enter a number",
}).refine((n) => n > 0, { message: "Enter a quantity greater than zero" });

const unitCost = z.preprocess(
  (v) => (v === null || v === undefined || (typeof v === "string" && v.trim().length === 0) ? "0" : v),
  decimalField({ decimals: 2, requiredMessage: "Enter a cost", invalidMessage: "Enter a number" }).refine(
    (n) => n >= 0,
    { message: "Must be zero or more" }
  )
);

export const purchaseOrderLineSchema = z.object({
  variantId: z.string().uuid("Choose a product"),
  quantityOrdered: orderedQuantity,
  unitCost,
});

export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineSchema>;

export const createPurchaseOrderSchema = z
  .object({
    supplierId: z.string().uuid("Choose a supplier"),
    branchId: z.string().uuid("Choose a branch"),
    // <input type="date"> submits "" when empty, and a date otherwise.
    expectedDate: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date")]).optional(),
    notes: optionalTrimmed(2000),
    lines: z.array(purchaseOrderLineSchema).min(1, "Add at least one product").max(200),
  })
  .superRefine((data, ctx) => {
    // The database's unique (purchase_order_id, variant_id) would reject
    // this too, but as a failed save with a raw constraint name rather
    // than a message pointing at the offending row.
    const seen = new Map<string, number>();
    data.lines.forEach((line, index) => {
      if (seen.has(line.variantId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "This product is already on the order — change the quantity on the existing line instead.",
          path: ["lines", index, "variantId"],
        });
      }
      seen.set(line.variantId, index);
    });
  });

export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

/**
 * A receiving submission: one entry per line, most of them typically
 * zero. Zero means "none of this arrived" and is skipped server-side —
 * it is not an error, because the form submits every line.
 */
const receivedQuantity = z.preprocess(
  (v) => (v === null || v === undefined || (typeof v === "string" && v.trim().length === 0) ? "0" : v),
  decimalField({ decimals: 3, requiredMessage: "Enter a quantity", invalidMessage: "Enter a number" }).refine(
    (n) => n >= 0,
    { message: "Cannot be negative" }
  )
);

export const receivePurchaseOrderSchema = z
  .object({
    note: optionalTrimmed(500),
    receipts: z
      .array(z.object({ itemId: z.string().uuid(), quantity: receivedQuantity }))
      .min(1, "Nothing to receive"),
  })
  .superRefine((data, ctx) => {
    if (!data.receipts.some((r) => r.quantity > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a quantity for at least one line.",
        path: ["receipts"],
      });
    }
  });

export type ReceivePurchaseOrderInput = z.infer<typeof receivePurchaseOrderSchema>;

export const PURCHASE_ORDER_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "approved", label: "Approved" },
  { value: "partially_received", label: "Partly received" },
  { value: "received", label: "Received" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export function purchaseOrderStatusLabel(value: string): string {
  return PURCHASE_ORDER_STATUSES.find((s) => s.value === value)?.label ?? value;
}

/** Which statuses still allow goods to be booked in. Mirrors the database rule in migration 0016. */
export function isReceivable(status: string): boolean {
  return status === "approved" || status === "partially_received";
}
