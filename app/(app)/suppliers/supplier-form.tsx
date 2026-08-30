"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/button";
import type { SupplierInput } from "@/lib/validation/purchasing";
import type { FormState } from "./actions";

const initialState: FormState = {};

interface SupplierFormProps {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  defaultValues?: Partial<SupplierInput>;
  submitLabel: string;
  pendingLabel: string;
}

/** Shared by app/(app)/suppliers/new and .../[id]/edit — same fields, different bound action. */
export function SupplierForm({ action, defaultValues, submitLabel, pendingLabel }: SupplierFormProps) {
  const [state, formAction] = useFormState(action, initialState);

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <Field label="Supplier name" name="name" required defaultValue={defaultValues?.name} error={state.fieldErrors?.name} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Contact person (optional)"
          name="contactName"
          defaultValue={defaultValues?.contactName}
          error={state.fieldErrors?.contactName}
        />
        <Field label="Phone (optional)" name="phone" type="tel" defaultValue={defaultValues?.phone} error={state.fieldErrors?.phone} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Email (optional)" name="email" type="email" defaultValue={defaultValues?.email} error={state.fieldErrors?.email} />
        <Field
          label="Payment terms (optional)"
          name="paymentTerms"
          placeholder="e.g. 30 days, cash on delivery"
          defaultValue={defaultValues?.paymentTerms}
          error={state.fieldErrors?.paymentTerms}
        />
      </div>

      <Textarea label="Address (optional)" name="address" defaultValue={defaultValues?.address} error={state.fieldErrors?.address} />
      <Textarea label="Notes (optional)" name="notes" defaultValue={defaultValues?.notes} error={state.fieldErrors?.notes} />

      <SubmitButton pendingText={pendingLabel} className="mt-2 self-start px-6">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}
