import { describe, expect, it } from "vitest";
import {
  calculateDiscountAmount,
  calculateGhanaTax,
  formatMoney,
  fromMinorUnits,
  isDiscountWithinCap,
  toMinorUnits,
  toNumber,
} from "@/lib/money/money";

describe("minor unit conversion", () => {
  it("converts decimal amounts to integer minor units", () => {
    expect(toMinorUnits(19.99)).toBe(1999);
    expect(toMinorUnits(0.1)).toBe(10);
    expect(toMinorUnits(100)).toBe(10000);
  });

  it("accepts numeric(14,2) columns as returned by supabase-js (JSON strings, not numbers — Phase 5's product prices)", () => {
    // PostgREST serializes `numeric` as a string specifically to avoid
    // float precision loss over the wire — this is what a real
    // product_variants.selling_price value looks like by the time it
    // reaches application code, not a plain JS number.
    expect(toMinorUnits("19.99")).toBe(1999);
    expect(toNumber("19.99")).toBe(19.99);
  });

  it("rejects a non-numeric string instead of silently producing NaN", () => {
    expect(() => toMinorUnits("not-a-number")).toThrow();
    expect(() => toNumber("not-a-number")).toThrow();
  });

  it("treats an empty string as 0, matching JS's own Number('') coercion, rather than throwing", () => {
    // Number("") is 0, not NaN — this is standard (if surprising) JS
    // behavior, not a gap in toNumber(). Documented via a passing test
    // instead of silently relying on it, after an earlier version of this
    // test wrongly asserted toNumber("") throws.
    expect(toNumber("")).toBe(0);
  });

  it("round-trips without floating point drift", () => {
    // The classic 0.1 + 0.2 !== 0.3 failure mode, done in minor units.
    const a = toMinorUnits(0.1);
    const b = toMinorUnits(0.2);
    expect(fromMinorUnits(a + b)).toBe(0.3);
  });

  it("formats money with the correct currency symbol", () => {
    expect(formatMoney(12345, "GHS")).toBe("GH₵123.45");
    expect(formatMoney(100, "USD")).toBe("$1.00");
  });
});

describe("calculateDiscountAmount", () => {
  it("computes a percentage discount", () => {
    expect(calculateDiscountAmount(10000, { type: "percentage", value: 10 })).toBe(1000);
  });

  it("computes a fixed discount", () => {
    expect(calculateDiscountAmount(10000, { type: "fixed", value: 500 })).toBe(500);
  });

  it("never exceeds the subtotal", () => {
    expect(calculateDiscountAmount(1000, { type: "fixed", value: 5000 })).toBe(1000);
    expect(calculateDiscountAmount(1000, { type: "percentage", value: 100 })).toBe(1000);
  });

  it("rejects an out-of-range percentage", () => {
    expect(() => calculateDiscountAmount(1000, { type: "percentage", value: 150 })).toThrow();
    expect(() => calculateDiscountAmount(1000, { type: "percentage", value: -5 })).toThrow();
  });

  it("rejects a negative fixed discount", () => {
    expect(() => calculateDiscountAmount(1000, { type: "fixed", value: -100 })).toThrow();
  });
});

describe("isDiscountWithinCap", () => {
  it("allows a discount at or under the cap", () => {
    expect(isDiscountWithinCap(10000, { type: "percentage", value: 5 }, 5)).toBe(true);
    expect(isDiscountWithinCap(10000, { type: "fixed", value: 500 }, 5)).toBe(true); // exactly 5%
  });

  it("rejects a discount over the cap, including an equivalent fixed amount", () => {
    expect(isDiscountWithinCap(10000, { type: "percentage", value: 20 }, 5)).toBe(false);
    expect(isDiscountWithinCap(10000, { type: "fixed", value: 2000 }, 5)).toBe(false); // 20% in disguise
  });

  it("a manager's higher cap allows what a cashier's cap rejects", () => {
    const subtotal = 10000;
    const discount = { type: "percentage" as const, value: 15 };
    expect(isDiscountWithinCap(subtotal, discount, 5)).toBe(false); // cashier cap
    expect(isDiscountWithinCap(subtotal, discount, 20)).toBe(true); // manager cap
  });
});

describe("calculateGhanaTax", () => {
  const rates = { vatRate: 0.15, nhilLevyRate: 0.025, getfundLevyRate: 0.025, covidLevyRate: 0.01 };

  it("applies NHIL/GETFund/COVID levies before VAT, then VAT on top", () => {
    const result = calculateGhanaTax(10000, rates);
    // levies: 250 + 250 + 100 = 600; VAT base = 10600; VAT = 1590
    expect(result.nhilLevy).toBe(250);
    expect(result.getfundLevy).toBe(250);
    expect(result.covidLevy).toBe(100);
    expect(result.vat).toBe(1590);
    expect(result.total).toBe(250 + 250 + 100 + 1590);
  });

  it("rejects a negative taxable amount", () => {
    expect(() => calculateGhanaTax(-1, rates)).toThrow();
  });

  it("returns all zeros for a zero taxable amount", () => {
    const result = calculateGhanaTax(0, rates);
    expect(result.total).toBe(0);
  });
});

