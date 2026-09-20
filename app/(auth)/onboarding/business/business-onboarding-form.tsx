"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/button";
import { completeBusinessOnboarding, type CompleteBusinessFormState } from "./actions";

const initialState: CompleteBusinessFormState = {};

export function BusinessOnboardingForm({
  next,
  defaultFirstName,
  defaultLastName,
}: {
  next: string;
  defaultFirstName: string;
  defaultLastName: string;
}) {
  const [state, formAction] = useFormState(completeBusinessOnboarding, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <input type="hidden" name="next" value={next} />

      <Field
        label="Business name"
        name="businessName"
        required
        autoComplete="organization"
        error={state.fieldErrors?.businessName}
      />

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Your first name"
          name="ownerFirstName"
          required
          autoComplete="given-name"
          defaultValue={defaultFirstName}
          error={state.fieldErrors?.ownerFirstName}
        />
        <Field
          label="Your last name"
          name="ownerLastName"
          autoComplete="family-name"
          defaultValue={defaultLastName}
          error={state.fieldErrors?.ownerLastName}
        />
      </div>

      <Field label="Phone (optional)" name="phone" type="tel" autoComplete="tel" error={state.fieldErrors?.phone} />

      <SubmitButton pendingText="Setting up your business…" className="mt-2 w-full">
        Continue
      </SubmitButton>
    </form>
  );
}