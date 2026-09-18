"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/button";
import type { FormState } from "../actions";

const initialState: FormState = {};

/**
 * "Log an expiry date" — for stock that's already on hand, whether it was
 * just received (the Receive Stock form already asked; this covers
 * backfilling everything that arrived before expiry tracking was turned
 * on) or is being logged separately for some other reason. See
 * lib/validation/inventory.ts's addExpiryBatchSchema and migration 0055's
 * header for the "informational, not a remaining-quantity ledger" scope
 * decision this form's copy is written around.
 */
export function ExpiryBatchForm({
  action,
  variantId,
  branches,
}: {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  variantId: string;
  branches: { id: string; name: string }[];
}) {
  const [state, formAction] = useFormState(action, initialState);

  if (branches.length === 0) {
    return (
      <p className="text-sm text-neutral-500 dark:text-ink-muted">
        No stock on hand at any branch yet — receive some first.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <input type="hidden" name="variantId" value={variantId} />

      <Select
        label="Branch"
        name="branchId"
        defaultValue={branches[0]?.id}
        error={state.fieldErrors?.branchId}
        options={branches.map((b) => ({ value: b.id, label: b.name }))}
      />

      <Field
        label="Quantity"
        name="quantity"
        type="number"
        step="0.001"
        min={0.001}
        error={state.fieldErrors?.quantity}
      />

      <Field label="Expiry date" name="expiryDate" type="date" error={state.fieldErrors?.expiryDate} />

      <Textarea label="Note (optional)" name="note" error={state.fieldErrors?.note} />

      <SubmitButton pendingText="Logging…" className="self-start px-6">
        Log expiry date
      </SubmitButton>
    </form>
  );
}