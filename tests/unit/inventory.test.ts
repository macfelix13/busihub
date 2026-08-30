import { describe, expect, it } from "vitest";
import {
  ADJUSTMENT_REASONS,
  adjustStockSchema,
  adjustmentReasonLabel,
  formatQuantity,
  receiveStockSchema,
  stockCountSchema,
} from "@/lib/validation/inventory";

const BRANCH = "11111111-1111-1111-1111-111111111111";
const VARIANT = "22222222-2222-2222-2222-222222222222";

describe("formatQuantity", () => {
  it("drops the trailing zeros a numeric(14,3) column always carries", () => {
    // What PostgREST actually returns for numeric(14,3) is a string with
    // all three decimals present — "15.000", not 15.
    expect(formatQuantity("15.000")).toBe("15");
    expect(formatQuantity("2.500")).toBe("2.5");
    expect(formatQuantity("0.125")).toBe("0.125");
  });

  it("accepts plain numbers too", () => {
    expect(formatQuantity(15)).toBe("15");
    expect(formatQuantity(-3.5)).toBe("-3.5");
    expect(formatQuantity(0)).toBe("0");
  });

  it("degrades to 0 rather than rendering NaN", () => {
    expect(formatQuantity("not-a-number")).toBe("0");
  });
});

describe("adjustmentReasonLabel", () => {
  it("maps every catalog value to a human label", () => {
    for (const reason of ADJUSTMENT_REASONS) {
      expect(adjustmentReasonLabel(reason.value)).toBe(reason.label);
    }
  });

  it("falls back to the raw value for anything unrecognized", () => {
    expect(adjustmentReasonLabel("something_new")).toBe("something_new");
  });
});

describe("receiveStockSchema", () => {
  const valid = { branchId: BRANCH, variantId: VARIANT, quantity: "5", note: "" };

  it("accepts a positive quantity submitted as a form string", () => {
    const result = receiveStockSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.quantity).toBe(5);
  });

  it("accepts fractional quantities for weighed goods", () => {
    const result = receiveStockSchema.safeParse({ ...valid, quantity: "2.5" });
    expect(result.success).toBe(true);
  });

  it("rejects zero and negative receipts", () => {
    expect(receiveStockSchema.safeParse({ ...valid, quantity: "0" }).success).toBe(false);
    expect(receiveStockSchema.safeParse({ ...valid, quantity: "-1" }).success).toBe(false);
  });

  it("rejects more precision than the column stores, rather than letting Postgres round it silently", () => {
    // quantity_delta is numeric(14,3) — 0.0001 would be rounded away
    // server-side, so the number the user typed would not be the number
    // recorded in the ledger.
    expect(receiveStockSchema.safeParse({ ...valid, quantity: "0.0001" }).success).toBe(false);
    expect(receiveStockSchema.safeParse({ ...valid, quantity: "0.001" }).success).toBe(true);
  });

  it("rejects non-numeric and blank quantities", () => {
    expect(receiveStockSchema.safeParse({ ...valid, quantity: "abc" }).success).toBe(false);
    expect(receiveStockSchema.safeParse({ ...valid, quantity: "" }).success).toBe(false);
  });

  it("requires real uuids for branch and variant", () => {
    expect(receiveStockSchema.safeParse({ ...valid, branchId: "not-a-uuid" }).success).toBe(false);
    expect(receiveStockSchema.safeParse({ ...valid, variantId: "" }).success).toBe(false);
  });
});

describe("adjustStockSchema", () => {
  const valid = {
    branchId: BRANCH,
    variantId: VARIANT,
    direction: "decrease",
    quantity: "3",
    reason: "damaged",
    note: "",
  };

  it("accepts a well-formed adjustment", () => {
    expect(adjustStockSchema.safeParse(valid).success).toBe(true);
  });

  it("takes the quantity as a positive number plus an explicit direction", () => {
    // The sign is never typed by the user — see the schema comment. A
    // negative here means the form was tampered with.
    expect(adjustStockSchema.safeParse({ ...valid, quantity: "-3" }).success).toBe(false);
    expect(adjustStockSchema.safeParse({ ...valid, direction: "increase" }).success).toBe(true);
  });

  it("rejects an unknown direction or reason", () => {
    expect(adjustStockSchema.safeParse({ ...valid, direction: "sideways" }).success).toBe(false);
    expect(adjustStockSchema.safeParse({ ...valid, reason: "because" }).success).toBe(false);
  });

  it("requires a reason — an adjustment with no explanation defeats the ledger", () => {
    const withoutReason = {
      branchId: BRANCH,
      variantId: VARIANT,
      direction: "decrease",
      quantity: "3",
      note: "",
    };
    expect(adjustStockSchema.safeParse(withoutReason).success).toBe(false);
  });
});

describe("stockCountSchema", () => {
  const valid = { branchId: BRANCH, variantId: VARIANT, countedQuantity: "12", note: "" };

  it("accepts zero — counting nothing on the shelf is the point of counting", () => {
    const result = stockCountSchema.safeParse({ ...valid, countedQuantity: "0" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.countedQuantity).toBe(0);
  });

  it("rejects a negative count", () => {
    expect(stockCountSchema.safeParse({ ...valid, countedQuantity: "-1" }).success).toBe(false);
  });

  it("rejects a blank or non-numeric count instead of treating it as zero", () => {
    // z.coerce.number() turns "" into 0, which would silently wipe the
    // stock level — the schema has to catch this, not the database.
    expect(stockCountSchema.safeParse({ ...valid, countedQuantity: "" }).success).toBe(false);
    expect(stockCountSchema.safeParse({ ...valid, countedQuantity: "abc" }).success).toBe(false);
  });

  it("caps notes at a sane length", () => {
    expect(stockCountSchema.safeParse({ ...valid, note: "x".repeat(501) }).success).toBe(false);
    expect(stockCountSchema.safeParse({ ...valid, note: "x".repeat(500) }).success).toBe(true);
  });
});
