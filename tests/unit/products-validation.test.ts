import { describe, expect, it } from "vitest";
import { createProductSchema, variantRowSchema } from "@/lib/validation/products";

const baseProduct = {
  name: "Test Product",
  description: "",
  category: "",
  unitOfMeasure: "each",
  taxCategory: "standard",
  variantOptionNames: [],
};

const baseVariant = { sku: "", barcode: "", variantOptions: {}, costPrice: "10", sellingPrice: "25" };

describe("variant pricing", () => {
  it("parses prices submitted as form strings", () => {
    const result = variantRowSchema.safeParse(baseVariant);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.costPrice).toBe(10);
      expect(result.data.sellingPrice).toBe(25);
    }
  });

  it("refuses a blank selling price instead of silently making the product free", () => {
    // Regression: z.coerce.number() is Number(input) underneath, and
    // Number("") is a finite 0 — so a blank field used to parse as a
    // deliberate price of zero and create a free product.
    expect(variantRowSchema.safeParse({ ...baseVariant, sellingPrice: "" }).success).toBe(false);
    expect(variantRowSchema.safeParse({ ...baseVariant, sellingPrice: "   " }).success).toBe(false);
    expect(variantRowSchema.safeParse({ ...baseVariant, sellingPrice: null }).success).toBe(false);
  });

  it("still allows an explicit zero selling price when that is what was typed", () => {
    const result = variantRowSchema.safeParse({ ...baseVariant, sellingPrice: "0" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.sellingPrice).toBe(0);
  });

  it("treats a blank cost price as zero, which is deliberate", () => {
    // Unlike selling price, plenty of shops don't track cost at all.
    const result = variantRowSchema.safeParse({ ...baseVariant, costPrice: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.costPrice).toBe(0);
  });

  it("rejects prices with more precision than numeric(14,2) stores", () => {
    // 25.999 would be rounded to 26.00 by Postgres — the price recorded
    // would not be the price the user typed.
    expect(variantRowSchema.safeParse({ ...baseVariant, sellingPrice: "25.999" }).success).toBe(false);
    expect(variantRowSchema.safeParse({ ...baseVariant, sellingPrice: "25.99" }).success).toBe(true);
  });

  it("rejects negative and non-numeric prices", () => {
    expect(variantRowSchema.safeParse({ ...baseVariant, sellingPrice: "-1" }).success).toBe(false);
    expect(variantRowSchema.safeParse({ ...baseVariant, sellingPrice: "free" }).success).toBe(false);
  });
});

describe("createProductSchema", () => {
  it("accepts a simple product with one variant", () => {
    const result = createProductSchema.safeParse({ ...baseProduct, variants: [baseVariant] });
    expect(result.success).toBe(true);
  });

  it("requires at least one variant", () => {
    expect(createProductSchema.safeParse({ ...baseProduct, variants: [] }).success).toBe(false);
  });

  it("flags a duplicate SKU within one submission", () => {
    const result = createProductSchema.safeParse({
      ...baseProduct,
      variantOptionNames: ["Size"],
      variants: [
        { ...baseVariant, sku: "DUP-1", variantOptions: { Size: "S" } },
        { ...baseVariant, sku: "dup-1", variantOptions: { Size: "M" } },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("Duplicate SKU"))).toBe(true);
    }
  });

  it("allows several blank SKUs in one submission (they all become NULL)", () => {
    const result = createProductSchema.safeParse({
      ...baseProduct,
      variantOptionNames: ["Size"],
      variants: [
        { ...baseVariant, sku: "", variantOptions: { Size: "S" } },
        { ...baseVariant, sku: "", variantOptions: { Size: "M" } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("reports a missing variant option at the path the form looks up", () => {
    const result = createProductSchema.safeParse({
      ...baseProduct,
      variantOptionNames: ["Size"],
      variants: [{ ...baseVariant, variantOptions: { Size: "" } }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "variants.0.variantOptions")).toBe(true);
    }
  });
});
