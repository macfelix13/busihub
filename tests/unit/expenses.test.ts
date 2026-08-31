import { describe, expect, it } from "vitest";
import {
  expenseSchema,
  voidExpenseSchema,
  paidFromLabel,
  isFutureDate,
  PAID_FROM,
} from "@/lib/validation/expenses";

/**
 * Expense validation.
 *
 * Two things here are worth more than the rest. The first is that a
 * blank amount must not arrive as a deliberate zero — `Number("")` is 0,
 * and an expense schema that trusts it records "GH₵0.00 spent on rent"
 * without complaint. The second is the date: an expense is money that
 * has already left, and a date field that accepts next month is the
 * easiest way to move a bad month's costs into a good one.
 */

const BRANCH = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "22222222-2222-4222-8222-222222222222";

function valid(overrides: Record<string, unknown> = {}) {
  return {
    branchId: BRANCH,
    categoryId: CATEGORY,
    description: "August rent",
    amount: "800",
    expenseDate: "2026-08-01",
    paidFrom: "bank",
    paymentReference: "",
    note: "",
    ...overrides,
  };
}

describe("expenseSchema", () => {
  it("accepts a complete expense and trims the description", () => {
    const result = expenseSchema.safeParse(valid({ description: "  August rent  " }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("August rent");
      expect(result.data.amount).toBe(800);
      expect(result.data.paidFrom).toBe("bank");
    }
  });

  it("allows no category — an uncategorised expense is still an expense", () => {
    // Forcing a shopkeeper to classify a GH₵2 sachet of water before
    // they can record it is how expenses stop getting recorded at all.
    const result = expenseSchema.safeParse(valid({ categoryId: "" }));
    expect(result.success).toBe(true);
  });

  it("refuses a blank amount rather than recording a zero", () => {
    for (const blank of ["", "   ", null, undefined]) {
      const result = expenseSchema.safeParse(valid({ amount: blank }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.join(".") === "amount")).toBe(true);
      }
    }
  });

  it("refuses zero, negative, and non-numeric amounts", () => {
    for (const bad of ["0", "-5", "abc", "1e", "--3"]) {
      expect(expenseSchema.safeParse(valid({ amount: bad })).success).toBe(false);
    }
  });

  it("refuses more precision than pesewas", () => {
    expect(expenseSchema.safeParse(valid({ amount: "45.505" })).success).toBe(false);
    expect(expenseSchema.safeParse(valid({ amount: "45.50" })).success).toBe(true);
    expect(expenseSchema.safeParse(valid({ amount: "45.5" })).success).toBe(true);
  });

  it("refuses a blank description", () => {
    for (const blank of ["", "   ", "\t"]) {
      const result = expenseSchema.safeParse(valid({ description: blank }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe("Say what the money was spent on");
      }
    }
  });

  it("refuses a date that is not a date", () => {
    for (const bad of ["", "yesterday", "01/08/2026", "2026-8-1", "2026-08"]) {
      expect(expenseSchema.safeParse(valid({ expenseDate: bad })).success).toBe(false);
    }
  });

  it("refuses a date that does not exist", () => {
    // Passes the regex, and `new Date` would roll it forward into March
    // without complaining — which would silently file February's expense
    // in the wrong month.
    expect(expenseSchema.safeParse(valid({ expenseDate: "2026-02-31" })).success).toBe(false);
    expect(expenseSchema.safeParse(valid({ expenseDate: "2026-13-01" })).success).toBe(false);
    expect(expenseSchema.safeParse(valid({ expenseDate: "2026-02-28" })).success).toBe(true);
    // A real leap day must still be accepted.
    expect(expenseSchema.safeParse(valid({ expenseDate: "2028-02-29" })).success).toBe(true);
  });

  it("refuses a payment source that is not one of the four", () => {
    expect(expenseSchema.safeParse(valid({ paidFrom: "bitcoin" })).success).toBe(false);
    expect(expenseSchema.safeParse(valid({ paidFrom: "" })).success).toBe(false);
    for (const source of PAID_FROM) {
      expect(expenseSchema.safeParse(valid({ paidFrom: source.value })).success).toBe(true);
    }
  });

  it("refuses a branch that is not a uuid", () => {
    expect(expenseSchema.safeParse(valid({ branchId: "the main one" })).success).toBe(false);
    expect(expenseSchema.safeParse(valid({ branchId: "" })).success).toBe(false);
  });

  it("treats a missing optional field as empty rather than failing", () => {
    // These are only sometimes rendered, so formData.get() returns null —
    // and z.string() rejects null, which would fail the whole form on a
    // field that is not on screen. (The bug that broke cash checkout.)
    const result = expenseSchema.safeParse(valid({ paymentReference: null, note: null }));
    expect(result.success).toBe(true);
  });
});

describe("voidExpenseSchema", () => {
  it("requires a reason worth reading", () => {
    expect(voidExpenseSchema.safeParse({ reason: "" }).success).toBe(false);
    expect(voidExpenseSchema.safeParse({ reason: "  " }).success).toBe(false);
    expect(voidExpenseSchema.safeParse({ reason: "x" }).success).toBe(false);
    expect(voidExpenseSchema.safeParse({ reason: "Recorded twice" }).success).toBe(true);
  });

  it("trims the reason", () => {
    const result = voidExpenseSchema.safeParse({ reason: "  Recorded twice  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reason).toBe("Recorded twice");
  });
});

describe("isFutureDate", () => {
  it("compares against the shop's day, not the server's", () => {
    // 23:30 UTC on the 31st is already the 1st in Auckland, so an expense
    // dated the 1st is today there and the future in Accra.
    const now = new Date("2026-08-31T23:30:00Z");

    expect(isFutureDate("2026-09-01", "Pacific/Auckland", now)).toBe(false);
    expect(isFutureDate("2026-09-01", "Africa/Accra", now)).toBe(true);
  });

  it("treats today as not future, and tomorrow as future", () => {
    const now = new Date("2026-08-31T09:00:00Z");

    expect(isFutureDate("2026-08-31", "Africa/Accra", now)).toBe(false);
    expect(isFutureDate("2026-08-30", "Africa/Accra", now)).toBe(false);
    expect(isFutureDate("2026-09-01", "Africa/Accra", now)).toBe(true);
  });

  it("falls back to Accra rather than throwing on an unknown zone", () => {
    const now = new Date("2026-08-31T09:00:00Z");
    expect(isFutureDate("2026-09-01", "Middle/Earth", now)).toBe(true);
    expect(isFutureDate("2026-08-31", "Middle/Earth", now)).toBe(false);
  });
});

describe("paidFromLabel", () => {
  it("names each source", () => {
    expect(paidFromLabel("cash")).toBe("Cash from the till");
    expect(paidFromLabel("momo")).toBe("Mobile money");
    expect(paidFromLabel("bank")).toBe("Bank");
  });

  it("returns the raw value rather than blank for something unknown", () => {
    // A row from a future migration should still render as something.
    expect(paidFromLabel("cheque")).toBe("cheque");
  });
});