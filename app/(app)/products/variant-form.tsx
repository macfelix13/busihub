"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/button";
import type { FormState } from "./actions";

const initialState: FormState = {};

interface VariantFormProps {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  optionNames: string[];
  defaultValues?: {
    sku?: string;
    barcode?: string;
    variantOptions?: Record<string, string>;
    costPrice?: number;
    sellingPrice?: number;
  };
  /**
   * Whether the caller may set/see the price fields on this submission.
   * true for "add a new variant" (products.edit is enough — see
   * supabase/migrations/0013's file header) and for "edit an existing
   * variant" only when the caller also has products.change_price. When
   * false, the price fields are shown read-only rather than omitted
   * entirely, so the user can still see what the price is.
   */
  canSetPrice: boolean;
  submitLabel: string;
  pendingLabel: string;
}

/** Shared by app/(app)/products/[id]/variants/new and .../[variantId]/edit. */
export function VariantForm({ action, optionNames, defaultValues, canSetPrice, submitLabel, pendingLabel }: VariantFormProps) {
  const [state, formAction] = useFormState(action, initialState);
  const [variantOptions, setVariantOptions] = useState<Record<string, string>>(() =>
    Object.fromEntries(optionNames.map((n) => [n, defaultValues?.variantOptions?.[n] ?? ""]))
  );

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      {optionNames.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {optionNames.map((name) => (
            <Field
              key={name}
              label={name}
              value={variantOptions[name] ?? ""}
              onChange={(e) => setVariantOptions((prev) => ({ ...prev, [name]: e.target.value }))}
              error={state.fieldErrors?.variantOptions}
            />
          ))}
        </div>
      ) : null}
      <input type="hidden" name="variantOptionsJson" value={JSON.stringify(variantOptions)} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="SKU (optional)" name="sku" defaultValue={defaultValues?.sku} error={state.fieldErrors?.sku} />
        <Field label="Barcode (optional)" name="barcode" defaultValue={defaultValues?.barcode} error={state.fieldErrors?.barcode} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {canSetPrice ? (
          <>
            <Field
              label="Cost price"
              name="costPrice"
              type="number"
              step="0.01"
              min={0}
              defaultValue={defaultValues?.costPrice ?? 0}
              error={state.fieldErrors?.costPrice}
            />
            <Field
              label="Selling price"
              name="sellingPrice"
              type="number"
              step="0.01"
              min={0}
              defaultValue={defaultValues?.sellingPrice}
              error={state.fieldErrors?.sellingPrice}
            />
          </>
        ) : (
          <>
            {/* Not permitted to set price (products.change_price) on an existing variant — still submit the current values unchanged rather than omitting them, and show them read-only for context. */}
            <input type="hidden" name="costPrice" value={defaultValues?.costPrice ?? 0} />
            <input type="hidden" name="sellingPrice" value={defaultValues?.sellingPrice ?? 0} />
            <p className="text-sm text-neutral-500 sm:col-span-2">
              Cost price GH₵{(defaultValues?.costPrice ?? 0).toFixed(2)} · Selling price GH₵{(defaultValues?.sellingPrice ?? 0).toFixed(2)}
              — you don&apos;t have permission to change prices.
            </p>
          </>
        )}
      </div>

      <SubmitButton pendingText={pendingLabel} className="mt-2 self-start px-6">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}
