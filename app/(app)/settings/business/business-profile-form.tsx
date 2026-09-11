"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/button";
import type { BusinessProfileInput } from "@/lib/validation/business-settings";
import { updateBusinessProfile, type SettingsFormState } from "./actions";

const initialState: SettingsFormState = {};

export function BusinessProfileForm({ defaultValues }: { defaultValues: BusinessProfileInput }) {
  const [state, formAction] = useFormState(updateBusinessProfile, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="rounded-xl bg-green-50 px-3.5 py-2.5 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          Saved.
        </p>
      ) : null}

      <Field label="Business name" name="name" required defaultValue={defaultValues.name} error={state.fieldErrors?.name} />
      <Field label="Business type" name="businessType" placeholder="e.g. Retail, Restaurant, Pharmacy" defaultValue={defaultValues.businessType} error={state.fieldErrors?.businessType} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Email" name="email" type="email" defaultValue={defaultValues.email} error={state.fieldErrors?.email} />
        <Field label="Phone" name="phone" type="tel" defaultValue={defaultValues.phone} error={state.fieldErrors?.phone} />
        <Field label="Address line 1" name="addressLine1" defaultValue={defaultValues.addressLine1} error={state.fieldErrors?.addressLine1} />
        <Field label="Address line 2" name="addressLine2" defaultValue={defaultValues.addressLine2} error={state.fieldErrors?.addressLine2} />
        <Field label="City" name="city" defaultValue={defaultValues.city} error={state.fieldErrors?.city} />
        <Field label="Region" name="region" defaultValue={defaultValues.region} error={state.fieldErrors?.region} />
      </div>

      <SubmitButton pendingText="Saving…" className="mt-2 self-start px-6">
        Save profile
      </SubmitButton>
    </form>
  );
}
