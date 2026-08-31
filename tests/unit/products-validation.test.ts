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

describe("createProductSchema — opening stock", () => {
  const base = {
    name: "Opening Stock Rice",
    description: "",
    category: "",
    unitOfMeasure: "each",
    taxCategory: "standard",
    variantOptionNames: [],
    variants: [{ sku: "OSR-1", barcode: "", variantOptions: {}, costPrice: "30", sellingPrice: "60" }],
    branchId: "",
  };
  const BRANCH = "11111111-1111-1111-1111-111111111111";

  it("treats a blank opening stock as none, so a product can be added before it arrives", () => {
    const result = createProductSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.variants[0]?.openingStock).toBe(0);
  });

  it("accepts a quantity with a branch", () => {
    const result = createProductSchema.safeParse({
      ...base,
      branchId: BRANCH,
      variants: [{ ...base.variants[0], openingStock: "40" }],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.variants[0]?.openingStock).toBe(40);
  });

  it("asks where the stock is, rather than guessing a branch", () => {
    const result = createProductSchema.safeParse({
      ...base,
      variants: [{ ...base.variants[0], openingStock: "40" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "branchId")).toBe(true);
    }
  });

  it("does not ask for a branch when there is no stock to place", () => {
    expect(
      createProductSchema.safeParse({ ...base, variants: [{ ...base.variants[0], openingStock: "0" }] }).success
    ).toBe(true);
  });

  it("refuses a negative opening stock — that is an adjustment, not an opening balance", () => {
    expect(
      createProductSchema.safeParse({
        ...base,
        branchId: BRANCH,
        variants: [{ ...base.variants[0], openingStock: "-5" }],
      }).success
    ).toBe(false);
  });

  it("refuses a quantity that is not a number", () => {
    expect(
      createProductSchema.safeParse({
        ...base,
        branchId: BRANCH,
        variants: [{ ...base.variants[0], openingStock: "forty" }],
      }).success
    ).toBe(false);
  });

  it("allows a weighed quantity to three decimals", () => {
    const ok = createProductSchema.safeParse({
      ...base,
      branchId: BRANCH,
      variants: [{ ...base.variants[0], openingStock: "12.500" }],
    });
    expect(ok.success).toBe(true);
    expect(
      createProductSchema.safeParse({
        ...base,
        branchId: BRANCH,
        variants: [{ ...base.variants[0], openingStock: "12.5005" }],
      }).success
    ).toBe(false);
  });
});
