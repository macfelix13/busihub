"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/button";
import { setOwnPin, type PinFormState } from "./actions";

const initialState: PinFormState = {};

export function PinForm({ hasPin }: { hasPin: boolean }) {
  const [state, formAction] = useFormState(setOwnPin, initialState);

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="rounded-xl bg-green-50 px-3.5 py-2.5 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
          {state.success}
        </p>
      ) : null}

      <Field
        label={hasPin ? "New PIN" : "PIN"}
        name="pin"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        error={state.fieldErrors?.pin}
      />
      <Field
        label="Confirm PIN"
        name="confirmPin"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        error={state.fieldErrors?.confirmPin}
      />

      <SubmitButton pendingText="Saving…" className="mt-2 self-start px-6">
        {hasPin ? "Change PIN" : "Set PIN"}
      </SubmitButton>
    </form>
  );
}