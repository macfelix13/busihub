import { describe, expect, it } from "vitest";
import {
  createProductSchema,
  variantRowSchema,
  quickAddProductSchema,
  isAllowedProductPhotoFile,
  ALLOWED_PRODUCT_PHOTO_MIME_TYPES,
  MAX_PRODUCT_PHOTO_BYTES,
} from "@/lib/validation/products";

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

describe("createProductSchema — expiry date", () => {
  const BRANCH = "11111111-1111-1111-1111-111111111111";
  const base = {
    name: "Yoghurt",
    description: "",
    category: "",
    unitOfMeasure: "each",
    taxCategory: "standard",
    variantOptionNames: [] as string[],
    branchId: BRANCH,
  };
  const variantWithStock = { sku: "", barcode: "", variantOptions: {}, costPrice: "5", sellingPrice: "8", openingStock: "20" };

  it("accepts a real date attached to real opening stock", () => {
    const result = createProductSchema.safeParse({
      ...base,
      variants: [{ ...variantWithStock, expiryDate: "2026-12-31" }],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.variants[0]?.expiryDate).toBe("2026-12-31");
  });

  it("leaves expiry date blank by default", () => {
    const result = createProductSchema.safeParse({ ...base, variants: [variantWithStock] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.variants[0]?.expiryDate).toBeFalsy();
  });

  it("rejects a date that doesn't exist, catching what a bare regex would miss", () => {
    // 2026 is not a leap year — Feb 31 would silently roll into March if
    // this only checked the YYYY-MM-DD shape.
    expect(
      createProductSchema.safeParse({ ...base, variants: [{ ...variantWithStock, expiryDate: "2026-02-31" }] }).success
    ).toBe(false);
  });

  it("refuses an expiry date with no real opening stock to attach it to", () => {
    const result = createProductSchema.safeParse({
      ...base,
      variants: [{ ...variantWithStock, openingStock: "0", expiryDate: "2026-12-31" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "variants.0.expiryDate")).toBe(true);
    }
  });
});

describe("quickAddProductSchema", () => {
  const BRANCH = "11111111-1111-1111-1111-111111111111";
  const base = { name: "Walk-in item", sellingPrice: "15", openingStock: "3", branchId: BRANCH };

  it("accepts a minimal name + price + quantity + branch", () => {
    const result = quickAddProductSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sellingPrice).toBe(15);
      expect(result.data.openingStock).toBe(3);
    }
  });

  it("requires a name", () => {
    expect(quickAddProductSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
  });

  it("refuses a blank selling price rather than treating it as free", () => {
    expect(quickAddProductSchema.safeParse({ ...base, sellingPrice: "" }).success).toBe(false);
  });

  it("requires a positive quantity — unlike the full Add Product form, blank or zero is not a valid answer here", () => {
    // The whole point of this form is ringing something up right now;
    // create_sale() refuses a sale against zero stock, so a zero/blank
    // quantity here would just create a product nobody can actually sell.
    expect(quickAddProductSchema.safeParse({ ...base, openingStock: "" }).success).toBe(false);
    expect(quickAddProductSchema.safeParse({ ...base, openingStock: "0" }).success).toBe(false);
    expect(quickAddProductSchema.safeParse({ ...base, openingStock: "-1" }).success).toBe(false);
  });

  it("requires a real branch id — there is no 'decide later' the way the full form allows", () => {
    expect(quickAddProductSchema.safeParse({ ...base, branchId: "" }).success).toBe(false);
    expect(quickAddProductSchema.safeParse({ ...base, branchId: "not-a-uuid" }).success).toBe(false);
  });
});

describe("isAllowedProductPhotoFile", () => {
  it("accepts a small file of an allowed image type", () => {
    for (const type of ALLOWED_PRODUCT_PHOTO_MIME_TYPES) {
      expect(isAllowedProductPhotoFile({ type, size: 1024 })).toBe(true);
    }
  });

  it("rejects a disallowed mime type even at a valid size", () => {
    expect(isAllowedProductPhotoFile({ type: "application/pdf", size: 1024 })).toBe(false);
    expect(isAllowedProductPhotoFile({ type: "image/gif", size: 1024 })).toBe(false);
  });

  it("rejects an empty file", () => {
    expect(isAllowedProductPhotoFile({ type: "image/png", size: 0 })).toBe(false);
  });

  it("rejects a file over the size cap, and accepts one right at it", () => {
    expect(isAllowedProductPhotoFile({ type: "image/png", size: MAX_PRODUCT_PHOTO_BYTES + 1 })).toBe(false);
    expect(isAllowedProductPhotoFile({ type: "image/png", size: MAX_PRODUCT_PHOTO_BYTES })).toBe(true);
  });
});