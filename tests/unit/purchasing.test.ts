import { describe, expect, it } from "vitest";
import {
  createPurchaseOrderSchema,
  isReceivable,
  purchaseOrderStatusLabel,
  receivePurchaseOrderSchema,
  supplierSchema,
} from "@/lib/validation/purchasing";

const SUPPLIER = "11111111-1111-1111-1111-111111111111";
const BRANCH = "22222222-2222-2222-2222-222222222222";
const VARIANT_A = "33333333-3333-3333-3333-333333333333";
const VARIANT_B = "44444444-4444-4444-4444-444444444444";
const ITEM_A = "55555555-5555-5555-5555-555555555555";
const ITEM_B = "66666666-6666-6666-6666-666666666666";

describe("supplierSchema", () => {
  const valid = { name: "Accra Wholesale", contactName: "", phone: "", email: "", address: "", paymentTerms: "", notes: "" };

  it("accepts a supplier with only a name", () => {
    expect(supplierSchema.safeParse(valid).success).toBe(true);
  });

  it("requires a name", () => {
    expect(supplierSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
    expect(supplierSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });

  it("allows a blank email but validates one that is given", () => {
    expect(supplierSchema.safeParse({ ...valid, email: "" }).success).toBe(true);
    expect(supplierSchema.safeParse({ ...valid, email: "sales@example.com" }).success).toBe(true);
    expect(supplierSchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
  });
});

describe("createPurchaseOrderSchema", () => {
  const line = { variantId: VARIANT_A, quantityOrdered: "10", unitCost: "8.50" };
  const valid = { supplierId: SUPPLIER, branchId: BRANCH, expectedDate: "", notes: "", lines: [line] };

  it("accepts a well-formed order", () => {
    const result = createPurchaseOrderSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      const [first] = result.data.lines;
      expect(first?.quantityOrdered).toBe(10);
      expect(first?.unitCost).toBe(8.5);
    }
  });

  it("requires at least one line", () => {
    expect(createPurchaseOrderSchema.safeParse({ ...valid, lines: [] }).success).toBe(false);
  });

  it("requires a product to be chosen on every line", () => {
    expect(
      createPurchaseOrderSchema.safeParse({ ...valid, lines: [{ ...line, variantId: "" }] }).success
    ).toBe(false);
  });

  it("rejects zero and negative quantities", () => {
    expect(createPurchaseOrderSchema.safeParse({ ...valid, lines: [{ ...line, quantityOrdered: "0" }] }).success).toBe(false);
    expect(createPurchaseOrderSchema.safeParse({ ...valid, lines: [{ ...line, quantityOrdered: "-5" }] }).success).toBe(false);
  });

  it("rejects a blank quantity rather than reading it as zero", () => {
    expect(createPurchaseOrderSchema.safeParse({ ...valid, lines: [{ ...line, quantityOrdered: "" }] }).success).toBe(false);
  });

  it("treats a blank unit cost as zero, deliberately", () => {
    const result = createPurchaseOrderSchema.safeParse({ ...valid, lines: [{ ...line, unitCost: "" }] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.lines[0]?.unitCost).toBe(0);
  });

  it("rejects costs finer than numeric(14,2)", () => {
    expect(createPurchaseOrderSchema.safeParse({ ...valid, lines: [{ ...line, unitCost: "8.555" }] }).success).toBe(false);
  });

  it("flags the same product appearing on two lines, at that line's path", () => {
    // The database's unique (purchase_order_id, variant_id) would reject
    // this anyway, but with a raw constraint name and no row to point at.
    const result = createPurchaseOrderSchema.safeParse({
      ...valid,
      lines: [line, { ...line, quantityOrdered: "3" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "lines.1.variantId")).toBe(true);
    }
  });

  it("allows two different products", () => {
    const result = createPurchaseOrderSchema.safeParse({
      ...valid,
      lines: [line, { ...line, variantId: VARIANT_B }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a blank expected date but rejects a malformed one", () => {
    expect(createPurchaseOrderSchema.safeParse({ ...valid, expectedDate: "" }).success).toBe(true);
    expect(createPurchaseOrderSchema.safeParse({ ...valid, expectedDate: "2026-09-15" }).success).toBe(true);
    expect(createPurchaseOrderSchema.safeParse({ ...valid, expectedDate: "15/09/2026" }).success).toBe(false);
  });
});

describe("receivePurchaseOrderSchema", () => {
  it("accepts a partial delivery where only one line arrived", () => {
    const result = receivePurchaseOrderSchema.safeParse({
      note: "",
      receipts: [
        { itemId: ITEM_A, quantity: "4" },
        { itemId: ITEM_B, quantity: "" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const [firstLine, secondLine] = result.data.receipts;
      expect(firstLine?.quantity).toBe(4);
      // A blank line is zero here — that IS "none of this arrived", and
      // it's filtered out before reaching the database.
      expect(secondLine?.quantity).toBe(0);
    }
  });

  it("refuses a submission where nothing was entered at all", () => {
    // Every line blank means the form was submitted by accident; sending
    // it would just produce a database error.
    const result = receivePurchaseOrderSchema.safeParse({
      note: "",
      receipts: [
        { itemId: ITEM_A, quantity: "" },
        { itemId: ITEM_B, quantity: "0" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "receipts")).toBe(true);
    }
  });

  it("rejects a negative received quantity", () => {
    expect(
      receivePurchaseOrderSchema.safeParse({ note: "", receipts: [{ itemId: ITEM_A, quantity: "-2" }] }).success
    ).toBe(false);
  });

  it("rejects a non-numeric quantity instead of treating it as zero", () => {
    expect(
      receivePurchaseOrderSchema.safeParse({ note: "", receipts: [{ itemId: ITEM_A, quantity: "all" }] }).success
    ).toBe(false);
  });
});

describe("order status helpers", () => {
  it("only allows receiving against approved and partly-received orders", () => {
    // Mirrors the database rule in migration 0016 — if these drift, the
    // UI offers a button that can only fail.
    expect(isReceivable("approved")).toBe(true);
    expect(isReceivable("partially_received")).toBe(true);
    expect(isReceivable("draft")).toBe(false);
    expect(isReceivable("received")).toBe(false);
    expect(isReceivable("cancelled")).toBe(false);
  });

  it("labels every status", () => {
    expect(purchaseOrderStatusLabel("partially_received")).toBe("Partly received");
    expect(purchaseOrderStatusLabel("draft")).toBe("Draft");
    expect(purchaseOrderStatusLabel("something_else")).toBe("something_else");
  });
});
