"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/button";
import { ACCOUNT_ENTRY_TYPES } from "@/lib/validation/customers";
import type { FormState } from "./actions";

const initialState: FormState = {};

interface AccountEntryFormProps {
  mode: "payment" | "charge";
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  branches: { id: string; name: string }[];
  currencyCode: string;
  /** Shown so the user can see what they're changing before they change it. */
  currentBalanceLabel: string;
}

export function AccountEntryForm({ mode, action, branches, currencyCode, currentBalanceLabel }: AccountEntryFormProps) {
  const [state, formAction] = useFormState(action, initialState);
  const isPayment = mode === "payment";

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <p className="rounded-xl bg-neutral-100 px-3.5 py-2.5 text-sm text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
        {currentBalanceLabel}
      </p>

      {!isPayment ? (
        <>
          <Select
            label="Entry type"
            name="entryType"
            defaultValue="charge"
            error={state.fieldErrors?.entryType}
            options={ACCOUNT_ENTRY_TYPES.map((t) => ({ value: t.value, label: t.label }))}
          />
          <Select
            label="Direction"
            name="direction"
            defaultValue="increase"
            error={state.fieldErrors?.direction}
            options={[
              { value: "increase", label: "Increase — they owe more" },
              { value: "decrease", label: "Decrease — they owe less" },
            ]}
          />
        </>
      ) : null}

      <Field
        label={`Amount (${currencyCode})`}
        name="amount"
        type="number"
        step="0.01"
        min={0.01}
        error={state.fieldErrors?.amount}
      />
      <p className="-mt-2 text-sm text-neutral-500">
        {isPayment
          ? "What the customer has handed over. Paying more than they owe leaves them in credit."
          : "Entered as a positive amount — the direction above decides which way it moves."}
      </p>

      {branches.length > 0 ? (
        <Select
          label="Branch (optional)"
          name="branchId"
          defaultValue=""
          error={state.fieldErrors?.branchId}
          options={[{ value: "", label: "Not recorded" }, ...branches.map((b) => ({ value: b.id, label: b.name }))]}
        />
      ) : null}

      <Textarea label="Note (optional)" name="note" error={state.fieldErrors?.note} />

      <SubmitButton pendingText="Recording…" className="mt-2 self-start px-6">
        {isPayment ? "Record payment" : "Record entry"}
      </SubmitButton>
    </form>
  );
}
