import { z } from "zod";
import { decimalField } from "./numeric";

/**
 * Shared client+server validation for customers and their account
 * entries (Phase 8). The Server Action re-validates all of this; the
 * client is never trusted on its own.
 */

const optionalTrimmed = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

/** Money is numeric(14,2); blank never silently means zero (see lib/validation/numeric.ts). */
const money = (requiredMessage: string) =>
  decimalField({ decimals: 2, requiredMessage, invalidMessage: "Enter a number" });

export const customerSchema = z.object({
  name: z.string().trim().min(1, "Customer name is required").max(200),
  phone: optionalTrimmed(40),
  email: z.union([z.literal(""), z.string().trim().email("Enter a valid email address").max(255)]).optional(),
  address: optionalTrimmed(500),
  notes: optionalTrimmed(2000),
  // Blank is a deliberate zero here — "no credit" is the safe default and
  // the commonest answer, so an empty box shouldn't be an error.
  creditLimit: z.preprocess(
    (v) => (v === null || v === undefined || (typeof v === "string" && v.trim().length === 0) ? "0" : v),
    money("Enter a credit limit").refine((n) => n >= 0, { message: "Cannot be negative" })
  ),
});

export type CustomerInput = z.infer<typeof customerSchema>;

export const customerStatusSchema = z.enum(["active", "archived"]);

/**
 * A payment is entered as a positive amount and stored negative by
 * record_customer_payment() — the sign convention lives in the database,
 * not in each caller (see migration 0017).
 */
export const customerPaymentSchema = z.object({
  amount: money("Enter an amount").refine((n) => n > 0, { message: "Enter an amount greater than zero" }),
  branchId: z.union([z.literal(""), z.string().uuid()]).optional(),
  note: optionalTrimmed(500),
});

export type CustomerPaymentInput = z.infer<typeof customerPaymentSchema>;

export const ACCOUNT_ENTRY_TYPES = [
  { value: "charge", label: "Charge — they owe more" },
  { value: "adjustment", label: "Correction" },
] as const;

const ENTRY_TYPE_VALUES = ACCOUNT_ENTRY_TYPES.map((t) => t.value) as [string, ...string[]];

/**
 * A manual charge or correction. Like a stock adjustment, the direction
 * is chosen explicitly rather than typed as a sign — "-50" is too easy to
 * fat-finger for "50", and on a money ledger that is somebody's debt.
 */
export const customerChargeSchema = z.object({
  entryType: z.enum(ENTRY_TYPE_VALUES),
  direction: z.enum(["increase", "decrease"]),
  amount: money("Enter an amount").refine((n) => n > 0, { message: "Enter an amount greater than zero" }),
  branchId: z.union([z.literal(""), z.string().uuid()]).optional(),
  note: optionalTrimmed(500),
});

export type CustomerChargeInput = z.infer<typeof customerChargeSchema>;

export const ENTRY_TYPE_LABELS: Record<string, string> = {
  charge: "Charge",
  payment: "Payment",
  adjustment: "Correction",
  sale: "Sale",
  refund: "Refund",
};

/**
 * Mirrors normalize_phone() in migration 0017 so the UI can warn about a
 * duplicate before submitting. The database remains the authority — this
 * is a courtesy, not the check.
 */
export function normalizePhone(phone: string): string | null {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 0) return null;
  if (digits.length === 12 && digits.startsWith("233")) return "0" + digits.slice(3);
  if (digits.length === 9) return "0" + digits;
  return digits;
}

/**
 * A balance is owed by the customer when positive and owed TO them when
 * negative, per the sign convention fixed in migration 0017. Rendering
 * "-100" to a shopkeeper is not useful; this says which way it goes.
 */
export function describeBalance(balance: number): { label: string; owing: boolean; inCredit: boolean } {
  if (balance > 0) return { label: "owing", owing: true, inCredit: false };
  if (balance < 0) return { label: "in credit", owing: false, inCredit: true };
  return { label: "settled", owing: false, inCredit: false };
}
