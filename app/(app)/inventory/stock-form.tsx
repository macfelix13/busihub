"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import Link from "next/link";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/button";
import { ADJUSTMENT_REASONS, formatQuantity } from "@/lib/validation/inventory";
import type { FormState } from "./actions";

const initialState: FormState = {};

export interface VariantOption {
  id: string;
  label: string;
  unit: string;
}

interface StockFormProps {
  mode: "receive" | "adjust" | "count";
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  branchId: string;
  branchName: string;
  variants: VariantOption[];
  /** Current on-hand quantity per variant AT THIS BRANCH. Absent = zero. */
  quantities: Record<string, number>;
  defaultVariantId?: string;
}

const COPY = {
  receive: {
    quantityLabel: "Quantity received",
    submit: "Record receipt",
    pending: "Recording…",
    hint: "Adds to what's already on hand.",
  },
  adjust: {
    quantityLabel: "Quantity",
    submit: "Record adjustment",
    pending: "Recording…",
    hint: "Corrects what's on hand, with a reason for the record.",
  },
  count: {
    quantityLabel: "Counted quantity",
    submit: "Record count",
    pending: "Recording…",
    hint: "Enter what's actually on the shelf — this replaces the current figure.",
  },
} as const;

export function StockForm({ mode, action, branchId, branchName, variants, quantities, defaultVariantId }: StockFormProps) {
  const [state, formAction] = useFormState(action, initialState);
  const [variantId, setVariantId] = useState(defaultVariantId ?? variants[0]?.id ?? "");
  const [direction, setDirection] = useState<"decrease" | "increase">("decrease");

  const copy = COPY[mode];
  const selected = variants.find((v) => v.id === variantId);
  const onHand = quantities[variantId] ?? 0;

  if (variants.length === 0) {
    return (
      <p className="rounded-xl border border-neutral-200 px-3.5 py-8 text-center text-sm text-neutral-500 dark:border-neutral-800">
        There are no active products to stock yet.{" "}
        <Link href="/products/new" className="font-medium text-brand-700 dark:text-brand-300">
          Add a product
        </Link>{" "}
        first.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      {/* The branch is fixed for this entry, taken from the page you came
          from — changing it is a deliberate trip back to the list, rather
          than a dropdown that's easy to leave on the wrong value. */}
      <input type="hidden" name="branchId" value={branchId} />
      <p className="rounded-xl bg-neutral-100 px-3.5 py-2.5 text-sm text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
        Branch: <span className="font-medium">{branchName}</span>{" "}
        <Link href={`/inventory?branch=${branchId}`} className="ml-1 underline">
          change
        </Link>
      </p>

      <Select
        label="Product"
        name="variantId"
        value={variantId}
        onChange={(e) => setVariantId(e.target.value)}
        error={state.fieldErrors?.variantId}
        options={variants.map((v) => ({ value: v.id, label: v.label }))}
      />

      <p className="-mt-2 text-sm text-neutral-500">
        Currently on hand: <span className="font-medium tabular-nums">{formatQuantity(onHand)}</span>{" "}
        {selected?.unit}
      </p>

      {mode === "adjust" ? (
        <>
          <Select
            label="Direction"
            name="direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as "decrease" | "increase")}
            error={state.fieldErrors?.direction}
            options={[
              { value: "decrease", label: "Decrease — remove from stock" },
              { value: "increase", label: "Increase — add to stock" },
            ]}
          />
          <Select
            label="Reason"
            name="reason"
            defaultValue="damaged"
            error={state.fieldErrors?.reason}
            options={ADJUSTMENT_REASONS.map((r) => ({ value: r.value, label: r.label }))}
          />
        </>
      ) : null}

      <Field
        label={copy.quantityLabel}
        name={mode === "count" ? "countedQuantity" : "quantity"}
        type="number"
        step="0.001"
        min={mode === "count" ? 0 : 0.001}
        error={state.fieldErrors?.[mode === "count" ? "countedQuantity" : "quantity"]}
      />
      <p className="-mt-2 text-sm text-neutral-500">{copy.hint}</p>

      <Textarea label="Note (optional)" name="note" error={state.fieldErrors?.note} />

      <SubmitButton pendingText={copy.pending} className="mt-2 self-start px-6">
        {copy.submit}
      </SubmitButton>
    </form>
  );
}
