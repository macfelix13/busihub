import { z } from "zod";
import { decimalField } from "./numeric";

/**
 * Validation for returns (Phase 12).
 *
 * As with the till, no money appears here: create_refund() apportions the
 * amounts from the original sale line, so the customer is refunded what
 * they actually paid rather than anything a caller supplies.
 */

const returnedQuantity = z.preprocess(
  (v) => (v === null || v === undefined || (typeof v === "string" && v.trim().length === 0) ? "0" : v),
  decimalField({ decimals: 3, requiredMessage: "Enter a quantity", invalidMessage: "Enter a number" }).refine(
    (n) => n >= 0,
    { message: "Cannot be negative" }
  )
);

export const refundLineSchema = z.object({
  saleItemId: z.string().uuid(),
  quantity: returnedQuantity,
  /** Damaged goods are refunded but not put back on the shelf. */
  restock: z.boolean(),
});

export type RefundLineInput = z.infer<typeof refundLineSchema>;

export const refundSchema = z
  .object({
    method: z.enum(["cash", "credit"]),
    reason: z.string().trim().max(300).optional().or(z.literal("")),
    lines: z.array(refundLineSchema).min(1, "Choose what is coming back."),
  })
  .superRefine((data, ctx) => {
    if (!data.lines.some((l) => l.quantity > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a quantity for at least one item.",
        path: ["lines"],
      });
    }
  });

export type RefundInput = z.infer<typeof refundSchema>;

export const REFUND_METHODS = [
  { value: "cash", label: "Cash back" },
  { value: "credit", label: "Credit their account" },
] as const;

export function refundMethodLabel(value: string): string {
  return REFUND_METHODS.find((m) => m.value === value)?.label ?? value;
}
