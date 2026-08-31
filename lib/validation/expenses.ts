import { z } from "zod";
import { decimalField } from "./numeric";

/**
 * Validation for expenses (Phase 13).
 *
 * As with the till, the shape here is small on purpose. The database
 * derives the business from the branch, the author from the session, and
 * the reference number from its own sequence — so there is nothing in
 * this schema for a caller to forge. What is left is genuinely the
 * user's: what it was for, how much, when, and where the money came
 * from.
 *
 * Every rule below is also enforced in `create_expense()` (migration
 * 0031). This layer exists so the message arrives before the round trip,
 * not because it is the thing standing between a bad value and the
 * database.
 */

/** Where the money came from. Mirrors the CHECK on expenses.paid_from. */
export const PAID_FROM = [
  { value: "cash", label: "Cash from the till", hint: "Comes out of the drawer" },
  { value: "momo", label: "Mobile money" },
  { value: "bank", label: "Bank" },
  { value: "other", label: "Somewhere else" },
] as const;

export type PaidFrom = (typeof PAID_FROM)[number]["value"];

export function paidFromLabel(value: string): string {
  return PAID_FROM.find((p) => p.value === value)?.label ?? value;
}

/** A `YYYY-MM-DD` string from a date input, and nothing else. */
const dateField = z
  .string({ errorMap: () => ({ message: "Choose a date" }) })
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
    // Rejects 2026-02-31, which passes the regex and which Date would
    // otherwise roll forward into March without complaint.
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === (month ?? 1) - 1 &&
      date.getUTCDate() === day
    );
  }, "That date doesn't exist");

export const expenseSchema = z.object({
  branchId: z.string().uuid("Choose a branch"),
  // Blank means "no category", which is allowed: forcing a shopkeeper to
  // classify a GH₵2 sachet of water before they can record it is how
  // expenses stop getting recorded at all.
  categoryId: z.union([z.literal(""), z.string().uuid("Choose a category")]).optional(),
  description: z
    .string({ errorMap: () => ({ message: "Say what the money was spent on" }) })
    .trim()
    .min(1, "Say what the money was spent on")
    .max(200, "Keep this under 200 characters"),
  amount: decimalField({
    decimals: 2,
    requiredMessage: "Enter how much was spent",
    invalidMessage: "Enter an amount, e.g. 45.50",
  }).refine((n) => n > 0, { message: "The amount must be more than zero" }),
  expenseDate: dateField,
  paidFrom: z.enum(["cash", "momo", "bank", "other"], {
    errorMap: () => ({ message: "Choose where the money came from" }),
  }),
  paymentReference: z
    .preprocess((v) => (v === null || v === undefined ? "" : v), z.string().trim().max(100))
    .optional(),
  note: z.preprocess((v) => (v === null || v === undefined ? "" : v), z.string().trim().max(500)).optional(),
});

export type ExpenseInput = z.infer<typeof expenseSchema>;

/**
 * Voiding needs a reason, and the reason is the whole point: a voided
 * expense stays on the page, and a blank reason leaves an unexplained
 * hole in the month's figures for whoever reads it next.
 */
export const voidExpenseSchema = z.object({
  reason: z
    .string({ errorMap: () => ({ message: "Say why this is being voided" }) })
    .trim()
    .min(3, "Say why this is being voided")
    .max(200, "Keep this under 200 characters"),
});

/**
 * Is this date in the future, in the shop's own timezone?
 *
 * The database refuses a future-dated expense against ITS clock, which is
 * UTC. A shop in UTC+3 recording tonight's purchase would otherwise be
 * told the date does not exist yet. Compared as date strings, because
 * that is what both sides are actually working with.
 */
export function isFutureDate(value: string, timezone: string, now: Date = new Date()): boolean {
  let today: string;
  try {
    today = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Accra",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  }
  return value > today;
}