"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/button";
import { UNITS_OF_MEASURE, TAX_CATEGORIES, type ProductDetailsInput } from "@/lib/validation/products";
import type { FormState } from "./actions";

const initialState: FormState = {};
const UNIT_OPTIONS = UNITS_OF_MEASURE.map((u) => ({ value: u.value, label: u.label }));
const TAX_OPTIONS = TAX_CATEGORIES.map((c) => ({ value: c.value, label: c.label }));

interface ProductDetailsFormProps {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  defaultValues: ProductDetailsInput;
}

/** Edits a product's shared catalog fields only — SKU/barcode/price live per-variant and are edited from that variant's own page. */
export function ProductDetailsForm({ action, defaultValues }: ProductDetailsFormProps) {
  const [state, formAction] = useFormState(action, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <Field label="Product name" name="name" required defaultValue={defaultValues.name} error={state.fieldErrors?.name} />
      <Textarea label="Description (optional)" name="description" defaultValue={defaultValues.description} error={state.fieldErrors?.description} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Category (optional)" name="category" defaultValue={defaultValues.category} error={state.fieldErrors?.category} />
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

      <SubmitButton pendingText="Saving…" className="mt-2 self-start px-6">
        Save changes
      </SubmitButton>
    </form>
  );
}

