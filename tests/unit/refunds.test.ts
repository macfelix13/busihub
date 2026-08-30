import { describe, expect, it } from "vitest";
import { refundSchema, refundLineSchema, refundMethodLabel, REFUND_METHODS } from "@/lib/validation/refunds";

const ITEM_A = "33333333-3333-3333-3333-333333333333";
const ITEM_B = "44444444-4444-4444-4444-444444444444";

/**
 * The form posts a row for every line on the sale, most of them blank —
 * the cashier types a quantity only against what is actually coming back.
 * So "blank" has to mean "not returning this", while a typed 0 means the
 * same thing, and neither may become a refund line.
 */
const valid = {
  method: "cash",
  reason: "",
  lines: [
    { saleItemId: ITEM_A, quantity: "1", restock: true },
    { saleItemId: ITEM_B, quantity: "", restock: true },
  ],
};

describe("refundSchema", () => {
  it("accepts a partial return with the untouched lines left blank", () => {
    const result = refundSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lines[0]?.quantity).toBe(1);
      expect(result.data.lines[1]?.quantity).toBe(0);
    }
  });

  it("treats a blank quantity as zero rather than rejecting the whole form", () => {
    const result = refundLineSchema.safeParse({ saleItemId: ITEM_A, quantity: "   ", restock: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.quantity).toBe(0);
  });

  it("refuses a return where nothing is actually coming back", () => {
    const allBlank = {
      ...valid,
      lines: valid.lines.map((l) => ({ ...l, quantity: "" })),
    };
    const result = refundSchema.safeParse(allBlank);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "lines")).toBe(true);
    }
  });

  it("refuses an explicit zero across every line for the same reason", () => {
    expect(refundSchema.safeParse({ ...valid, lines: valid.lines.map((l) => ({ ...l, quantity: "0" })) }).success).toBe(
      false
    );
  });

  it("refuses a negative quantity — a return cannot add stock back to a sale", () => {
    expect(
      refundSchema.safeParse({ ...valid, lines: [{ saleItemId: ITEM_A, quantity: "-1", restock: true }] }).success
    ).toBe(false);
  });

  it("refuses a quantity that is not a number", () => {
    expect(
      refundSchema.safeParse({ ...valid, lines: [{ saleItemId: ITEM_A, quantity: "two", restock: true }] }).success
    ).toBe(false);
  });

  it("refuses more than three decimal places", () => {
    expect(
      refundSchema.safeParse({ ...valid, lines: [{ saleItemId: ITEM_A, quantity: "1.0005", restock: true }] }).success
    ).toBe(false);
    expect(
      refundSchema.safeParse({ ...valid, lines: [{ saleItemId: ITEM_A, quantity: "1.005", restock: true }] }).success
    ).toBe(true);
  });

  it("refuses a line that is not a real sale line id", () => {
    expect(
      refundSchema.safeParse({ ...valid, lines: [{ saleItemId: "not-a-uuid", quantity: "1", restock: true }] }).success
    ).toBe(false);
  });

  it("refuses a return with no lines at all", () => {
    expect(refundSchema.safeParse({ ...valid, lines: [] }).success).toBe(false);
  });

  it("only allows the two ways money can go back", () => {
    expect(refundSchema.safeParse({ ...valid, method: "credit" }).success).toBe(true);
    expect(refundSchema.safeParse({ ...valid, method: "momo" }).success).toBe(false);
    expect(refundSchema.safeParse({ ...valid, method: "" }).success).toBe(false);
  });

  it("keeps the restock flag, because damaged goods are refunded but not shelved", () => {
    const result = refundSchema.safeParse({
      ...valid,
      lines: [{ saleItemId: ITEM_A, quantity: "1", restock: false }],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.lines[0]?.restock).toBe(false);
  });

  it("requires the restock flag to be a real boolean", () => {
    expect(
      refundSchema.safeParse({ ...valid, lines: [{ saleItemId: ITEM_A, quantity: "1", restock: "yes" }] }).success
    ).toBe(false);
  });

  it("trims the reason and caps its length", () => {
    const ok = refundSchema.safeParse({ ...valid, reason: "  Wrong size  " });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.reason).toBe("Wrong size");
    expect(refundSchema.safeParse({ ...valid, reason: "x".repeat(301) }).success).toBe(false);
  });

  it("carries no money field — amounts come from the original sale, never the form", () => {
    const result = refundSchema.safeParse({ ...valid, total: 999999, unitPrice: 999999 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data).sort()).toEqual(["lines", "method", "reason"]);
    }
  });
});

describe("refundMethodLabel", () => {
  it("labels both methods", () => {
    expect(refundMethodLabel("cash")).toBe("Cash back");
    expect(refundMethodLabel("credit")).toBe("Credit their account");
  });

  it("falls back to the raw value rather than rendering nothing", () => {
    expect(refundMethodLabel("something-new")).toBe("something-new");
  });

  it("offers exactly the methods the database accepts", () => {
    expect(REFUND_METHODS.map((m) => m.value)).toEqual(["cash", "credit"]);
  });
});
