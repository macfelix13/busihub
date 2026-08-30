import { describe, expect, it } from "vitest";
import {
  customerSchema,
  customerChargeSchema,
  customerPaymentSchema,
  describeBalance,
  normalizePhone,
} from "@/lib/validation/customers";

describe("normalizePhone", () => {
  it("folds the ways one Ghanaian mobile number gets written onto a single key", () => {
    // This must agree with normalize_phone() in migration 0017 — if the two
    // drift, the UI's duplicate warning stops matching what the database
    // actually enforces.
    for (const written of ["0244123456", "024 412 3456", "+233244123456", "233244123456", "244123456", "(024)-412-3456"]) {
      expect(normalizePhone(written)).toBe("0244123456");
    }
  });

  it("returns null for blank input", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
    expect(normalizePhone("---")).toBeNull();
  });

  it("leaves a non-Ghanaian number's digits alone rather than mangling it into a false match", () => {
    expect(normalizePhone("+44 7700 900123")).toBe("447700900123");
  });
});

describe("describeBalance", () => {
  it("says which way the money goes rather than showing a bare minus sign", () => {
    expect(describeBalance(250)).toMatchObject({ label: "owing", owing: true, inCredit: false });
    expect(describeBalance(-100)).toMatchObject({ label: "in credit", owing: false, inCredit: true });
    expect(describeBalance(0)).toMatchObject({ label: "settled", owing: false, inCredit: false });
  });
});

describe("customerSchema", () => {
  const valid = { name: "Ama Owusu", phone: "", email: "", address: "", notes: "", creditLimit: "500" };

  it("accepts a customer with only a name", () => {
    const result = customerSchema.safeParse({ ...valid, creditLimit: "" });
    expect(result.success).toBe(true);
    // Blank credit limit is a deliberate zero — "no credit" is the safe
    // default and the commonest answer, so it must not be an error.
    if (result.success) expect(result.data.creditLimit).toBe(0);
  });

  it("requires a name", () => {
    expect(customerSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
    expect(customerSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });

  it("parses a credit limit and rejects a negative one", () => {
    const result = customerSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.creditLimit).toBe(500);
    expect(customerSchema.safeParse({ ...valid, creditLimit: "-1" }).success).toBe(false);
  });

  it("rejects a credit limit finer than numeric(14,2)", () => {
    expect(customerSchema.safeParse({ ...valid, creditLimit: "500.005" }).success).toBe(false);
  });

  it("allows a blank email but validates one that is given", () => {
    expect(customerSchema.safeParse({ ...valid, email: "ama@example.com" }).success).toBe(true);
    expect(customerSchema.safeParse({ ...valid, email: "nope" }).success).toBe(false);
  });
});

describe("customerPaymentSchema", () => {
  const valid = { amount: "50", branchId: "", note: "" };

  it("accepts a positive payment", () => {
    const result = customerPaymentSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.amount).toBe(50);
  });

  it("rejects zero, negative, and blank amounts", () => {
    // Blank matters especially: Number("") is a finite 0, so without an
    // explicit check a mis-submitted form would post a zero payment.
    expect(customerPaymentSchema.safeParse({ ...valid, amount: "0" }).success).toBe(false);
    expect(customerPaymentSchema.safeParse({ ...valid, amount: "-50" }).success).toBe(false);
    expect(customerPaymentSchema.safeParse({ ...valid, amount: "" }).success).toBe(false);
  });

  it("accepts a blank branch but rejects a malformed one", () => {
    expect(customerPaymentSchema.safeParse({ ...valid, branchId: "" }).success).toBe(true);
    expect(customerPaymentSchema.safeParse({ ...valid, branchId: "not-a-uuid" }).success).toBe(false);
  });
});

describe("customerChargeSchema", () => {
  const valid = { entryType: "charge", direction: "increase", amount: "120", branchId: "", note: "" };

  it("accepts a well-formed charge", () => {
    expect(customerChargeSchema.safeParse(valid).success).toBe(true);
  });

  it("takes a positive amount plus an explicit direction, never a typed sign", () => {
    // On a money ledger a fat-fingered "-50" for "50" is somebody's debt,
    // so the sign is chosen from a dropdown, not typed.
    expect(customerChargeSchema.safeParse({ ...valid, amount: "-120" }).success).toBe(false);
    expect(customerChargeSchema.safeParse({ ...valid, direction: "decrease" }).success).toBe(true);
  });

  it("rejects an unknown direction or entry type", () => {
    expect(customerChargeSchema.safeParse({ ...valid, direction: "sideways" }).success).toBe(false);
    expect(customerChargeSchema.safeParse({ ...valid, entryType: "payment" }).success).toBe(false);
  });

  it("does not let the form post the entry types reserved for later phases", () => {
    // 'sale' and 'refund' are written by the sales phases, not by hand —
    // the database refuses them too (migration 0017's RLS policy).
    expect(customerChargeSchema.safeParse({ ...valid, entryType: "sale" }).success).toBe(false);
    expect(customerChargeSchema.safeParse({ ...valid, entryType: "refund" }).success).toBe(false);
  });
});
