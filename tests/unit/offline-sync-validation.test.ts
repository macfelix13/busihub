import { describe, expect, it } from "vitest";
import { queuedSaleSchema, syncRequestSchema, MAX_QUEUED_SALES_PER_BATCH } from "@/lib/validation/offline-sync";

/**
 * Validation for POST /api/sync (migration 0052's client half). Mirrors
 * the shape create_sale()'s p_client_transaction_id path actually
 * enforces server-side, so a request this schema accepts should never be
 * one the database goes on to refuse for a reason this file could have
 * caught first — momo/split, and a credit sale with no customer.
 */

const VARIANT_ID = "11111111-1111-1111-1111-111111111111";
const BRANCH_ID = "22222222-2222-2222-2222-222222222222";
const CUSTOMER_ID = "33333333-3333-3333-3333-333333333333";
const CLIENT_TXN_ID = "44444444-4444-4444-4444-444444444444";

function baseSale(overrides: Record<string, unknown> = {}) {
  return {
    clientTransactionId: CLIENT_TXN_ID,
    branchId: BRANCH_ID,
    paymentMethod: "cash",
    amountTendered: 20,
    items: [{ variantId: VARIANT_ID, quantity: 1 }],
    ...overrides,
  };
}

describe("queuedSaleSchema", () => {
  it("accepts a well-formed cash sale", () => {
    const result = queuedSaleSchema.safeParse(baseSale());
    expect(result.success).toBe(true);
  });

  it("accepts a well-formed on-account sale with a customer", () => {
    const result = queuedSaleSchema.safeParse(
      baseSale({ paymentMethod: "credit", customerId: CUSTOMER_ID, amountTendered: 0 })
    );
    expect(result.success).toBe(true);
  });

  it("rejects mobile money outright", () => {
    const result = queuedSaleSchema.safeParse(baseSale({ paymentMethod: "momo" }));
    expect(result.success).toBe(false);
  });

  it("rejects split (only a cash/momo combination makes sense online)", () => {
    const result = queuedSaleSchema.safeParse(baseSale({ paymentMethod: "split" }));
    expect(result.success).toBe(false);
  });

  it("rejects a credit sale with no customer", () => {
    const result = queuedSaleSchema.safeParse(baseSale({ paymentMethod: "credit", amountTendered: 0 }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "customerId");
      expect(issue).toBeDefined();
    }
  });

  it("requires a clientTransactionId", () => {
    const sale = baseSale() as Record<string, unknown>;
    delete sale.clientTransactionId;
    const result = queuedSaleSchema.safeParse(sale);
    expect(result.success).toBe(false);
  });

  it("rejects a clientTransactionId that isn't a UUID", () => {
    const result = queuedSaleSchema.safeParse(baseSale({ clientTransactionId: "not-a-uuid" }));
    expect(result.success).toBe(false);
  });

  it("requires at least one item", () => {
    const result = queuedSaleSchema.safeParse(baseSale({ items: [] }));
    expect(result.success).toBe(false);
  });

  it("treats a blank amountTendered as zero rather than rejecting it", () => {
    const result = queuedSaleSchema.safeParse(baseSale({ amountTendered: "" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amountTendered).toBe(0);
    }
  });

  it("rejects a negative amountTendered", () => {
    const result = queuedSaleSchema.safeParse(baseSale({ amountTendered: -5 }));
    expect(result.success).toBe(false);
  });

  it("carries a service line's renderer through untouched", () => {
    const result = queuedSaleSchema.safeParse(
      baseSale({
        items: [{ variantId: VARIANT_ID, quantity: 1, renderedByStaffId: CUSTOMER_ID }],
      })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items[0]?.renderedByStaffId).toBe(CUSTOMER_ID);
    }
  });
});

describe("syncRequestSchema", () => {
  it("accepts a batch of one or more sales", () => {
    const result = syncRequestSchema.safeParse({ sales: [baseSale()] });
    expect(result.success).toBe(true);
  });

  it("rejects an empty batch", () => {
    const result = syncRequestSchema.safeParse({ sales: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a batch larger than the cap", () => {
    const sales = Array.from({ length: MAX_QUEUED_SALES_PER_BATCH + 1 }, (_, i) =>
      baseSale({ clientTransactionId: `44444444-4444-4444-4444-${String(i).padStart(12, "0")}` })
    );
    const result = syncRequestSchema.safeParse({ sales });
    expect(result.success).toBe(false);
  });

  it("accepts a batch right at the cap", () => {
    const sales = Array.from({ length: MAX_QUEUED_SALES_PER_BATCH }, (_, i) =>
      baseSale({ clientTransactionId: `44444444-4444-4444-4444-${String(i).padStart(12, "0")}` })
    );
    const result = syncRequestSchema.safeParse({ sales });
    expect(result.success).toBe(true);
  });
});