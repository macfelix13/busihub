"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button, SubmitButton } from "@/components/ui/button";
import { UNITS_OF_MEASURE, TAX_CATEGORIES } from "@/lib/validation/products";
import { createProduct, type FormState } from "./actions";

const initialState: FormState = {};
const UNIT_OPTIONS = UNITS_OF_MEASURE.map((u) => ({ value: u.value, label: u.label }));
const TAX_OPTIONS = TAX_CATEGORIES.map((c) => ({ value: c.value, label: c.label }));

interface VariantRow {
  sku: string;
  barcode: string;
  variantOptions: Record<string, string>;
  costPrice: string;
  sellingPrice: string;
  /** What is already on the shelf. Blank means none. */
  openingStock: string;
}

export interface ProductFormBranch {
  id: string;
  name: string;
}

export type ProductFormType = "product" | "service";

function emptyVariant(optionNames: string[]): VariantRow {
  return {
    sku: "",
    barcode: "",
    variantOptions: Object.fromEntries(optionNames.map((n) => [n, ""])),
    costPrice: "0",
    sellingPrice: "",
    openingStock: "",
  };
}

/** Create-product form: base details + an optional variant-axis definition + one row per starting SKU. Every product needs at least one variant even if "This product comes in variants" stays unchecked — that single row becomes the product's sole (is_default) variant server-side. */
export function ProductForm({
  branches,
  canReceiveStock,
  initialType = "product",
}: {
  branches: ProductFormBranch[];
  canReceiveStock: boolean;
  initialType?: ProductFormType;
}) {
  const [state, formAction] = useFormState(createProduct, initialState);
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  // Type is fixed at creation — there is no "convert a product into a
  // service" flow, so this is a one-time choice, not something that can
  // be edited later (see migration 0040's header).
  const [type, setType] = useState<ProductFormType>(initialType);
  const isService = type === "service";

  const [hasVariants, setHasVariants] = useState(false);
  const [optionNamesText, setOptionNamesText] = useState("");
  const optionNames = optionNamesText
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 3);

  const [variants, setVariants] = useState<VariantRow[]>([emptyVariant([])]);

  function patchVariant(index: number, patch: Partial<VariantRow>) {
    setVariants((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function patchVariantOption(index: number, optionName: string, value: string) {
    setVariants((rows) =>
      rows.map((row, i) => (i === index ? { ...row, variantOptions: { ...row.variantOptions, [optionName]: value } } : row))
    );
  }

  function addRow() {
    setVariants((rows) => [...rows, emptyVariant(optionNames)]);
  }

  function removeRow(index: number) {
    setVariants((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== index) : rows));
  }

  const effectiveVariants = hasVariants ? variants : [variants[0] ?? emptyVariant([])];

  // The branch box only appears once there is stock to place, so a shop
  // adding a product that has not arrived yet is never asked where it is.
  // A service never carries stock (migration 0040 — create_product
  // ignores opening_stock entirely for type='service'), so this never
  // applies to one, regardless of what's in the boxes.
  const anyOpeningStock = !isService && effectiveVariants.some((row) => Number(row.openingStock) > 0);
  const effectiveOptionNames = hasVariants ? optionNames : [];

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">What is this?</span>
        <div className="flex gap-1 self-start rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
          <button
            type="button"
            onClick={() => setType("product")}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${
              !isService ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            Product
          </button>
          <button
            type="button"
            onClick={() => setType("service")}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${
              isService ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            Service
          </button>
        </div>
        {isService ? (
          <p className="text-sm text-neutral-500">
            A service (braiding, sewing, barbering...) is sold just like a product, but it never carries stock, and
            each sale of it will ask who rendered it.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-4">
        <Field label="Product name" name="name" required error={state.fieldErrors?.name} />
        <Textarea label="Description (optional)" name="description" error={state.fieldErrors?.description} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Category (optional)" name="category" error={state.fieldErrors?.category} />
          <Select label="Unit of measure" name="unitOfMeasure" defaultValue="each" error={state.fieldErrors?.unitOfMeasure} options={UNIT_OPTIONS} />
          <Select label="Tax category" name="taxCategory" defaultValue="standard" error={state.fieldErrors?.taxCategory} options={TAX_OPTIONS} />
        </div>
      </div>

      <div className="border-t border-neutral-200 pt-5 dark:border-neutral-800">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={hasVariants}
            onChange={(e) => {
              const checked = e.target.checked;
              setHasVariants(checked);
              if (!checked) {
                setVariants((rows) => [{ ...(rows[0] ?? emptyVariant([])), variantOptions: {} }]);
              }
            }}
            className="h-5 w-5 rounded border-neutral-300 text-brand-600 focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            This product comes in variants (e.g. different sizes or colors)
          </span>
        </label>

        {hasVariants ? (
          <div className="mt-4 max-w-md">
            <Field
              label="Variant options (comma-separated, up to 3 — e.g. Size, Color)"
              value={optionNamesText}
              onChange={(e) => setOptionNamesText(e.target.value)}
            />
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-4">
        <h3 className="font-semibold">{hasVariants ? "Variants" : "Pricing"}</h3>

        {hasVariants && effectiveOptionNames.length === 0 ? (
          <p className="text-sm text-neutral-500">Enter at least one variant option above to start adding variants.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {effectiveVariants.map((row, index) => (
              <div key={index} className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
                {hasVariants && effectiveOptionNames.length > 0 ? (
                  <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {effectiveOptionNames.map((name) => (
                      <Field
                        key={name}
                        label={name}
                        value={row.variantOptions[name] ?? ""}
                        onChange={(e) => patchVariantOption(index, name, e.target.value)}
                        error={state.fieldErrors?.[`variants.${index}.variantOptions`]}
                      />
                    ))}
                  </div>
                ) : null}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <Field
                    label="SKU (optional)"
                    value={row.sku}
                    onChange={(e) => patchVariant(index, { sku: e.target.value })}
                    error={state.fieldErrors?.[`variants.${index}.sku`]}
                  />
                  <Field
                    label="Barcode (optional)"
                    value={row.barcode}
                    onChange={(e) => patchVariant(index, { barcode: e.target.value })}
                    error={state.fieldErrors?.[`variants.${index}.barcode`]}
                  />
                  <Field
                    label="Cost price"
                    type="number"
                    step="0.01"
                    min={0}
                    value={row.costPrice}
                    onChange={(e) => patchVariant(index, { costPrice: e.target.value })}
                    error={state.fieldErrors?.[`variants.${index}.costPrice`]}
                  />
                  <Field
                    label="Selling price"
                    type="number"
                    step="0.01"
                    min={0}
                    value={row.sellingPrice}
                    onChange={(e) => patchVariant(index, { sellingPrice: e.target.value })}
                    error={state.fieldErrors?.[`variants.${index}.sellingPrice`]}
                  />
                </div>
                {canReceiveStock && !isService ? (
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
                    <Field
                      label="Stock on hand now"
                      type="number"
                      step="0.001"
                      min={0}
                      placeholder="0"
                      value={row.openingStock}
                      onChange={(e) => patchVariant(index, { openingStock: e.target.value })}
                      error={state.fieldErrors?.[`variants.${index}.openingStock`]}
                    />
                  </div>
                ) : null}
                {hasVariants && effectiveVariants.length > 1 ? (
                  <Button type="button" variant="ghost" className="mt-3" onClick={() => removeRow(index)}>
                    Remove this variant
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {hasVariants && effectiveOptionNames.length > 0 ? (
          <Button type="button" variant="secondary" className="self-start" onClick={addRow}>
            + Add variant
          </Button>
        ) : null}
      </div>

      {state.fieldErrors?.variants ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.fieldErrors.variants}
        </p>
      ) : null}

      {canReceiveStock && !isService && anyOpeningStock ? (
        <div className="flex flex-col gap-2">
          <Select
            label="Where is this stock?"
            name="branchId"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            error={state.fieldErrors?.branchId}
            options={branches.map((b) => ({ value: b.id, label: b.name }))}
          />
          <p className="text-sm text-neutral-500">
            This is recorded as stock received today, so it shows in the inventory history like any other delivery.
            Leave the boxes empty if the goods haven&apos;t arrived yet.
          </p>
        </div>
      ) : (
        <input type="hidden" name="branchId" value="" />
      )}

      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="variantOptionNamesJson" value={JSON.stringify(effectiveOptionNames)} />
      <input
        type="hidden"
        name="variantsJson"
        value={JSON.stringify(
          effectiveVariants.map((row) => ({
            sku: row.sku,
            barcode: row.barcode,
            variantOptions: hasVariants ? row.variantOptions : {},
            costPrice: row.costPrice,
            sellingPrice: row.sellingPrice,
            openingStock: canReceiveStock && !isService ? row.openingStock : "",
          }))
        )}
      />

      <SubmitButton pendingText="Creating…" className="self-start px-6">
        {isService ? "Create service" : "Create product"}
      </SubmitButton>
    </form>
  );
}