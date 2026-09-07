"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/button";
import { CategoryCombobox } from "@/components/ui/category-combobox";
import { UNITS_OF_MEASURE, TAX_CATEGORIES, type ProductDetailsInput } from "@/lib/validation/products";
import { ProductPhotoField } from "./product-photo-field";
import type { FormState } from "./actions";

const initialState: FormState = {};
const UNIT_OPTIONS = UNITS_OF_MEASURE.map((u) => ({ value: u.value, label: u.label }));
const TAX_OPTIONS = TAX_CATEGORIES.map((c) => ({ value: c.value, label: c.label }));

export interface ProductDetailsFormCategory {
  id: string;
  name: string;
  icon?: string | null;
}

interface ProductDetailsFormProps {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  defaultValues: ProductDetailsInput;
  categories: ProductDetailsFormCategory[];
  /** Type is fixed at creation (see product-form.tsx) — this form only ever shows the duration field for a service. */
  productType: "product" | "service";
  /** Whether typing a brand-new category name will actually create one — false for a caller who holds products.edit but not products.create. Cosmetic only: updateProductDetails() re-checks this itself either way. */
  canCreateCategory?: boolean;
  /** Already resolved to a short-lived signed URL by the page (migration 0046). Null means no photo yet. */
  photoUrl: string | null;
  /** Bound to this product's id — removeProductPhoto(productId). */
  onRemovePhoto: () => Promise<void>;
}

/** Edits a product's shared catalog fields only — SKU/barcode/price live per-variant and are edited from that variant's own page. */
export function ProductDetailsForm({
  action,
  defaultValues,
  categories,
  productType,
  canCreateCategory = true,
  photoUrl,
  onRemovePhoto,
}: ProductDetailsFormProps) {
  const [state, formAction] = useFormState(action, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <ProductPhotoField defaultPhotoUrl={photoUrl} onRemove={onRemovePhoto} />

      <Field label="Product name" name="name" required defaultValue={defaultValues.name} error={state.fieldErrors?.name} />
      <Textarea label="Description (optional)" name="description" defaultValue={defaultValues.description} error={state.fieldErrors?.description} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <CategoryCombobox
          name="categoryName"
          categories={categories}
          defaultValue={defaultValues.categoryName ?? ""}
          error={state.fieldErrors?.categoryName}
          canCreate={canCreateCategory}
        />
        <Select
          label="Unit of measure"
          name="unitOfMeasure"
          defaultValue={defaultValues.unitOfMeasure}
          error={state.fieldErrors?.unitOfMeasure}
          options={UNIT_OPTIONS}
        />
        <Select
          label="Tax category"
          name="taxCategory"
          defaultValue={defaultValues.taxCategory}
          error={state.fieldErrors?.taxCategory}
          options={TAX_OPTIONS}
        />
      </div>

      {productType === "service" ? (
        <Field
          label="Duration (minutes, optional)"
          name="durationMinutes"
          type="number"
          step="1"
          min={1}
          defaultValue={defaultValues.durationMinutes ?? ""}
          error={state.fieldErrors?.durationMinutes}
        />
      ) : null}

      <SubmitButton pendingText="Saving…" className="mt-2 self-start px-6">
        Save changes
      </SubmitButton>
    </form>
  );
}