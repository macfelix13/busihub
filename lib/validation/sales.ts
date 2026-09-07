import { z } from "zod";
import { decimalField } from "./numeric";
// One definition of the networks, shared with the Paystack settings — two
// lists would drift, and the one that drifted would be the one that
// prompts the wrong provider.
import { MOMO_NETWORKS, momoNetworkLabel } from "./payments";

/**
 * Validation for the till (Phase 9, extended for payments in Phase 10).
 *
 * Note how little is here: no prices, no tax, no totals. create_sale()
 * derives all of that from the catalog and the business's settings, so
 * there is nothing for a caller to get wrong or to forge. The only things
 * the till actually decides are which items, how many, who is paying and
 * how — and for mobile money, which phone to prompt.
 *
 * The one money figure the till does send is the CASH in the drawer,
 * because only the person at the counter knows what was handed over. Every
 * check on it still happens in the database.
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

export const cartLineSchema = z
  .object({
    variantId: z.string().uuid("Choose a product"),
    quantity: quantitySchema,
    // Who actually did the work, for a service line — from EITHER of two
    // pools (migration 0045): a real staff account (renderedByStaffId, a
    // profiles.id — migration 0040's original rendered_by) or a no-login
    // service provider (renderedByProviderId, a service_providers.id).
    // Blank for a product line, or when nothing was picked yet — the
    // database is what actually requires and validates exactly one of the
    // two for a service line (create_sale refuses a service line naming
    // neither, both, or someone outside the caller's own business/branch);
    // this is just shaped so a blank value round-trips cleanly rather than
    // failing .uuid() on "".
    renderedByStaffId: z.union([z.literal(""), z.string().uuid()]).optional(),
    renderedByProviderId: z.union([z.literal(""), z.string().uuid()]).optional(),
  })
  .refine((line) => !(line.renderedByStaffId && line.renderedByProviderId), {
    message: "Choose one renderer, not two.",
    path: ["renderedByStaffId"],
  });

export type CartLineInput = z.infer<typeof cartLineSchema>;

/**
 * Ghanaian mobile numbers, however the cashier types them: 024 412 3456,
 * 0244123456, +233 24 412 3456, 233244123456. All become 0244123456,
 * which is what Paystack expects — and getting this wrong means prompting
 * a stranger's phone, so it is normalised rather than merely accepted.
 */
export function normaliseMomoNumber(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "").replace(/^\+/, "");
  if (/^0\d{9}$/.test(digits)) return digits;
  if (/^233\d{9}$/.test(digits)) return `0${digits.slice(3)}`;
  // A bare nine-digit number is the local form with the leading 0 dropped
  // (24 412 3456), which is how people say it out loud.
  if (/^[2-5]\d{8}$/.test(digits)) return `0${digits}`;
  return null;
}

export const checkoutSchema = z
  .object({
    branchId: z.string().uuid("Choose a branch"),
    customerId: z.union([z.literal(""), z.string().uuid()]).optional(),
    paymentMethod: z.enum(["cash", "credit", "momo", "split"]),
    amountTendered: tenderedSchema,
    /** Only for a split: how much of the total is cash. */
    cashAmount: tenderedSchema,
    // NULL, not undefined. These inputs are only rendered for a mobile
    // money or split sale, so on a cash or on-account checkout
    // `formData.get("momoNumber")` returns null — and `z.string()`
    // rejects null, failing the whole sale on a field that is not even on
    // screen. That is exactly what happened: cash and on-account stopped
    // working the moment these fields were added.
    momoNumber: z.preprocess((v) => (v === null || v === undefined ? "" : v), z.string()),
    momoNetwork: z.preprocess((v) => (v === null || v === undefined ? "" : v), z.string()),
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

    if (data.paymentMethod === "momo" || data.paymentMethod === "split") {
      if (!normaliseMomoNumber(data.momoNumber ?? "")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Enter the customer's mobile money number, e.g. 024 412 3456.",
          path: ["momoNumber"],
        });
      }
      if (!MOMO_NETWORKS.some((n) => n.value === data.momoNetwork)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Choose their network.",
          path: ["momoNetwork"],
        });
      }
    }

    // A split with no cash in it is just a mobile money sale, and a split
    // where the cash covers everything is just a cash sale. Both are
    // refused so the receipt says what actually happened.
    if (data.paymentMethod === "split" && data.cashAmount <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter how much of this is cash, or choose Mobile money instead.",
        path: ["cashAmount"],
      });
    }

    // Same product twice would be two lines for one item; the till merges
    // them as you scan, so this only fires on a malformed submission. A
    // service is different on purpose: the till never merges service
    // lines (see till.tsx), because "barber A did the braiding, barber B
    // did the dreadlocks" is two lines of possibly the same service with
    // two different renderers — so the dedup key includes both renderer
    // fields (0045: either may be set, never both), and only a
    // byte-for-byte duplicate (same variant, same renderer, or same
    // product line twice) is rejected here.
    const seen = new Set<string>();
    data.items.forEach((line, index) => {
      const key = `${line.variantId}::${line.renderedByStaffId ?? ""}::${line.renderedByProviderId ?? ""}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "This item is already on the sale.",
          path: ["items", index, "variantId"],
        });
      }
      seen.add(key);
    });
  });

export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "momo", label: "Mobile money" },
  { value: "split", label: "Cash + mobile money" },
  { value: "credit", label: "On account" },
] as const;

export function paymentMethodLabel(value: string): string {
  return PAYMENT_METHODS.find((m) => m.value === value)?.label ?? value;
}

export { MOMO_NETWORKS, momoNetworkLabel };