import { z } from "zod";
import { decimalField } from "./numeric";

/**
 * Validation for the till (Phase 9).
 *
 * Note how little is here: no prices, no tax, no totals. create_sale()
 * (migration 0020) derives all of that from the catalog and the business's
 * settings, so there is nothing for a caller to get wrong or to forge. The
 * only things the till actually decides are which items, how many, who is
 * paying and how.
 */

const quantitySchema = decimalField({
  decimals: 3,
  requiredMessage: "Enter a quantity",
  invalidMessage: "Enter a number",
}).refine((n) => n > 0, { message: "Quantity must be more than zero" });

/** Cash tendered. Blank is a deliberate zero — the total check lives in the database. */
const tenderedSchema = z.preprocess(
  (v) => (v === null || v === undefined || (typeof v === "string" && v.trim().length === 0) ? "0" : v),
  decimalField({ decimals: 2, requiredMessage: "Enter an amount", invalidMessage: "Enter a number" }).refine(
    (n) => n >= 0,
    { message: "Cannot be negative" }
  )
);

export const cartLineSchema = z.object({
  variantId: z.string().uuid("Choose a product"),
  quantity: quantitySchema,
});

export type CartLineInput = z.infer<typeof cartLineSchema>;

export const checkoutSchema = z
  .object({
    branchId: z.string().uuid("Choose a branch"),
    customerId: z.union([z.literal(""), z.string().uuid()]).optional(),
    paymentMethod: z.enum(["cash", "credit"]),
    amountTendered: tenderedSchema,
    items: z.array(cartLineSchema).min(1, "Add something to the sale first."),
  })
  .superRefine((data, ctx) => {
    // The database enforces this too (a credit sale with no customer is
    // refused), but catching it here means the message arrives before the
    // round trip rather than as a rejected sale at the counter.
    if (data.paymentMethod === "credit" && !data.customerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose a customer to put this sale on account.",
        path: ["customerId"],
      });
    }

    // Same product twice would be two lines for one item; the till merges
    // them as you scan, so this only fires on a malformed submission.
    const seen = new Set<string>();
    data.items.forEach((line, index) => {
      if (seen.has(line.variantId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "This item is already on the sale.",
          path: ["items", index, "variantId"],
        });
      }
      seen.add(line.variantId);
    });
  });

export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "credit", label: "On account" },
] as const;

export function paymentMethodLabel(value: string): string {
  return PAYMENT_METHODS.find((m) => m.value === value)?.label ?? value;
}
