import { describe, expect, it } from "vitest";
import { checkoutSchema, paymentMethodLabel } from "@/lib/validation/sales";

const BRANCH = "11111111-1111-1111-1111-111111111111";
const CUSTOMER = "22222222-2222-2222-2222-222222222222";
const VARIANT_A = "33333333-3333-3333-3333-333333333333";
const VARIANT_B = "44444444-4444-4444-4444-444444444444";

const line = { variantId: VARIANT_A, quantity: "2" };
const valid = {
  branchId: BRANCH,
  customerId: "",
  paymentMethod: "cash",
  amountTendered: "100",
  items: [line],
};

describe("checkoutSchema", () => {
  it("accepts a cash sale to a walk-in", () => {
    const result = checkoutSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items[0]?.quantity).toBe(2);
      expect(result.data.amountTendered).toBe(100);
    }
  });

  it("refuses an empty sale", () => {
    expect(checkoutSchema.safeParse({ ...valid, items: [] }).success).toBe(false);
  });

  it("refuses zero or negative quantities", () => {
    expect(checkoutSchema.safeParse({ ...valid, items: [{ ...line, quantity: "0" }] }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...valid, items: [{ ...line, quantity: "-1" }] }).success).toBe(false);
  });

  it("requires a customer for a sale on account", () => {
    // The database refuses this too; catching it here means the message
    // arrives before the round trip rather than as a rejected sale with a
    // customer standing at the counter.
    const result = checkoutSchema.safeParse({ ...valid, paymentMethod: "credit", customerId: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "customerId")).toBe(true);
    }
  });

  it("accepts a credit sale that names a customer", () => {
    expect(
      checkoutSchema.safeParse({ ...valid, paymentMethod: "credit", customerId: CUSTOMER, amountTendered: "0" })
        .success
    ).toBe(true);
  });

  it("treats blank cash tendered as zero rather than erroring", () => {
    // Whether it is ENOUGH is the database's call — it knows the real
    // total, which the client only previews.
    const result = checkoutSchema.safeParse({ ...valid, amountTendered: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.amountTendered).toBe(0);
  });

  it("flags the same product on two lines", () => {
    const result = checkoutSchema.safeParse({ ...valid, items: [line, { ...line, quantity: "1" }] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "items.1.variantId")).toBe(true);
    }
  });

  it("allows two different products", () => {
    expect(checkoutSchema.safeParse({ ...valid, items: [line, { ...line, variantId: VARIANT_B }] }).success).toBe(
      true
    );
  });

  it("rejects an unknown payment method", () => {
    expect(checkoutSchema.safeParse({ ...valid, paymentMethod: "mobile_money" }).success).toBe(false);
  });

  it("carries no prices or totals at all", () => {
    // The point of the schema's shape: there is nothing here for a caller
    // to forge. create_sale() derives every figure server-side.
    const result = checkoutSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.items[0] ?? {})).toEqual(["variantId", "quantity"]);
      expect(result.data).not.toHaveProperty("total");
    }
  });
});

describe("paymentMethodLabel", () => {
  it("reads as a shopkeeper would say it", () => {
    expect(paymentMethodLabel("cash")).toBe("Cash");
    expect(paymentMethodLabel("credit")).toBe("On account");
    expect(paymentMethodLabel("something")).toBe("something");
  });
});
