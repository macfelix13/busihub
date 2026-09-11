"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Button, SubmitButton } from "@/components/ui/button";
import type { FormState } from "./actions";

const initialState: FormState = {};

interface VoidExpenseFormProps {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
}

/**
 * Voiding is behind a confirmation step, not because it is destructive —
 * nothing is deleted — but because it changes a month's figures and the
 * reason is what the next person reading the ledger will have to go on.
 * A one-click void produces reasons like "x".
 */
export function VoidExpenseForm({ action }: VoidExpenseFormProps) {
  const [state, formAction] = useFormState(action, initialState);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="danger" onClick={() => setOpen(true)}>
        Void this expense
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex max-w-lg flex-col gap-3" noValidate>
      {state.error ? (
        <p
          role="alert"
          className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {state.error}
        </p>
      ) : null}

      <Field
        label="Why is this being voided?"
        name="reason"
        required
        autoFocus
        placeholder="Recorded twice, wrong amount, paid by someone else"
        error={state.fieldErrors?.reason}
      />
      <p className="text-sm text-neutral-500 dark:text-ink-muted">
        It stops counting against profit straight away, and stays on this page with your reason attached.
      </p>

      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingText="Voiding…" variant="danger" className="px-6">
          Void it
        </SubmitButton>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
    </form>
  );
}