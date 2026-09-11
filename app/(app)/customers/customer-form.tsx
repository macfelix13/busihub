"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/button";
import type { CustomerInput } from "@/lib/validation/customers";
import type { FormState } from "./actions";

const initialState: FormState = {};

interface CustomerFormProps {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  defaultValues?: Partial<Record<keyof CustomerInput, string>>;
  currencyCode: string;
  submitLabel: string;
  pendingLabel: string;
}

/** Shared by app/(app)/customers/new and .../[id]/edit — same fields, different bound action. */
export function CustomerForm({ action, defaultValues, currencyCode, submitLabel, pendingLabel }: CustomerFormProps) {
  const [state, formAction] = useFormState(action, initialState);

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <Field label="Customer name" name="name" required defaultValue={defaultValues?.name} error={state.fieldErrors?.name} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Phone (optional)" name="phone" type="tel" defaultValue={defaultValues?.phone} error={state.fieldErrors?.phone} />
        <Field label="Email (optional)" name="email" type="email" defaultValue={defaultValues?.email} error={state.fieldErrors?.email} />
      </div>

      <Field
        label={`Credit limit (${currencyCode})`}
        name="creditLimit"
        type="number"
        step="0.01"
        min={0}
        defaultValue={defaultValues?.creditLimit ?? "0"}
        error={state.fieldErrors?.creditLimit}
      />
      <p className="-mt-2 text-sm text-neutral-500 dark:text-ink-muted">
        The most this customer may owe at any time. Leave it at 0 if they must pay at the till — charges beyond the limit
        are refused.
      </p>

      <Textarea label="Address (optional)" name="address" defaultValue={defaultValues?.address} error={state.fieldErrors?.address} />
      <Textarea label="Notes (optional)" name="notes" defaultValue={defaultValues?.notes} error={state.fieldErrors?.notes} />

      <SubmitButton pendingText={pendingLabel} className="mt-2 self-start px-6">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}