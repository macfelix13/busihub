"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/button";
import { PAID_FROM } from "@/lib/validation/expenses";
import type { FormState } from "./actions";

const initialState: FormState = {};

interface Option {
  value: string;
  label: string;
}

interface ExpenseFormProps {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  branches: Option[];
  categories: Option[];
  currencyCode: string;
  /** Today in the shop's timezone, as YYYY-MM-DD. */
  today: string;
}

export function ExpenseForm({ action, branches, categories, currencyCode, today }: ExpenseFormProps) {
  const [state, formAction] = useFormState(action, initialState);

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-4" noValidate>
      {state.error ? (
        <p
          role="alert"
          className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {state.error}
        </p>
      ) : null}

      <Field
        label="What was it for?"
        name="description"
        required
        placeholder="August rent, water bill, fuel for the generator"
        error={state.fieldErrors?.description}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label={`Amount (${currencyCode})`}
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          inputMode="decimal"
          required
          error={state.fieldErrors?.amount}
        />
        <Field
          label="Date"
          name="expenseDate"
          type="date"
          required
          defaultValue={today}
          // An expense is money that has already left, so the picker
          // itself stops at today. The database refuses a future date
          // regardless — this only saves the round trip.
          max={today}
          error={state.fieldErrors?.expenseDate}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Where did the money come from?"
          name="paidFrom"
          required
          defaultValue="cash"
          options={PAID_FROM.map((p) => ({ value: p.value, label: p.label }))}
          error={state.fieldErrors?.paidFrom}
        />
        <Select
          label="Category (optional)"
          name="categoryId"
          defaultValue=""
          options={[{ value: "", label: "No category" }, ...categories]}
          error={state.fieldErrors?.categoryId}
        />
      </div>

      <p className="-mt-2 text-sm text-neutral-500">
        Cash comes out of the till, so the drawer will be short by this amount at closing — which is exactly what you
        want it to say.
      </p>

      {branches.length > 1 ? (
        <Select
          label="Branch"
          name="branchId"
          required
          defaultValue={branches[0]?.value}
          options={branches}
          error={state.fieldErrors?.branchId}
        />
      ) : (
        <input type="hidden" name="branchId" value={branches[0]?.value ?? ""} />
      )}

      <Field
        label="Reference (optional)"
        name="paymentReference"
        placeholder="Momo transaction id, cheque number, receipt number"
        error={state.fieldErrors?.paymentReference}
      />

      <Textarea label="Note (optional)" name="note" error={state.fieldErrors?.note} />

      <SubmitButton pendingText="Recording…" className="mt-2 self-start px-6">
        Record expense
      </SubmitButton>
    </form>
  );
}