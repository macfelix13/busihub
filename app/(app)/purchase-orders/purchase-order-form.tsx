"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button, SubmitButton } from "@/components/ui/button";
import { createPurchaseOrder, type FormState } from "./actions";

const initialState: FormState = {};

export interface VariantChoice {
  id: string;
  label: string;
  /** Last known cost, used to prefill the line so the buyer isn't retyping it. */
  costPrice: number;
}

interface PurchaseOrderFormProps {
  suppliers: { id: string; name: string }[];
  branches: { id: string; name: string }[];
  variants: VariantChoice[];
  defaultSupplierId?: string;
  currencyCode: string;
}

interface LineRow {
  variantId: string;
  quantityOrdered: string;
  unitCost: string;
}

function emptyLine(): LineRow {
  return { variantId: "", quantityOrdered: "", unitCost: "" };
}

export function PurchaseOrderForm({
  suppliers,
  branches,
  variants,
  defaultSupplierId,
  currencyCode,
}: PurchaseOrderFormProps) {
  const [state, formAction] = useFormState(createPurchaseOrder, initialState);
  const [lines, setLines] = useState<LineRow[]>([emptyLine()]);

  // An unrecognized ?supplier= would leave the <select> falling back to
  // whichever supplier happens to be first alphabetically — and the order
  // would be raised against them, silently. Only prefill a real one.
  const initialSupplierId =
    defaultSupplierId && suppliers.some((s) => s.id === defaultSupplierId) ? defaultSupplierId : undefined;

  function patchLine(index: number, patch: Partial<LineRow>) {
    setLines((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  /** Picking a product prefills its cost — overwritable, but usually right. */
  function chooseVariant(index: number, variantId: string) {
    const variant = variants.find((v) => v.id === variantId);
    setLines((rows) =>
      rows.map((row, i) =>
        i === index
          ? { ...row, variantId, unitCost: row.unitCost || (variant ? String(variant.costPrice) : "") }
          : row
      )
    );
  }

  const total = lines.reduce((sum, line) => {
    const qty = Number(line.quantityOrdered);
    const cost = Number(line.unitCost);
    return sum + (Number.isFinite(qty) && Number.isFinite(cost) ? qty * cost : 0);
  }, 0);

  if (suppliers.length === 0 || variants.length === 0 || branches.length === 0) {
    return (
      <p className="rounded-xl border border-neutral-200 px-3.5 py-8 text-center text-sm text-neutral-500 dark:border-neutral-800">
        {suppliers.length === 0
          ? "Add a supplier before raising a purchase order."
          : variants.length === 0
            ? "Add a product before raising a purchase order."
            : "Add an active branch before raising a purchase order."}
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Supplier"
          name="supplierId"
          defaultValue={initialSupplierId}
          error={state.fieldErrors?.supplierId}
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
        />
        <Select
          label="Deliver to branch"
          name="branchId"
          error={state.fieldErrors?.branchId}
          options={branches.map((b) => ({ value: b.id, label: b.name }))}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Expected date (optional)" name="expectedDate" type="date" error={state.fieldErrors?.expectedDate} />
      </div>

      <div className="flex flex-col gap-4">
        <h3 className="font-semibold">Items</h3>
        {lines.map((line, index) => (
          <div key={index} className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr_1fr]">
              <Select
                label="Product"
                value={line.variantId}
                onChange={(e) => chooseVariant(index, e.target.value)}
                error={state.fieldErrors?.[`lines.${index}.variantId`]}
                options={[{ value: "", label: "Choose a product…" }, ...variants.map((v) => ({ value: v.id, label: v.label }))]}
              />
              <Field
                label="Quantity"
                type="number"
                step="0.001"
                min={0}
                value={line.quantityOrdered}
                onChange={(e) => patchLine(index, { quantityOrdered: e.target.value })}
                error={state.fieldErrors?.[`lines.${index}.quantityOrdered`]}
              />
              <Field
                label={`Unit cost (${currencyCode})`}
                type="number"
                step="0.01"
                min={0}
                value={line.unitCost}
                onChange={(e) => patchLine(index, { unitCost: e.target.value })}
                error={state.fieldErrors?.[`lines.${index}.unitCost`]}
              />
            </div>
            {lines.length > 1 ? (
              <Button type="button" variant="ghost" className="mt-3" onClick={() => setLines((r) => r.filter((_, i) => i !== index))}>
                Remove this line
              </Button>
            ) : null}
          </div>
        ))}

        <div className="flex items-center justify-between">
          <Button type="button" variant="secondary" onClick={() => setLines((r) => [...r, emptyLine()])}>
            + Add line
          </Button>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Estimated total:{" "}
            <span className="font-medium tabular-nums">
              {currencyCode} {total.toFixed(2)}
            </span>
          </p>
        </div>

        {state.fieldErrors?.lines ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.fieldErrors.lines}
          </p>
        ) : null}
      </div>

      <Textarea label="Notes (optional)" name="notes" error={state.fieldErrors?.notes} />

      <input
        type="hidden"
        name="linesJson"
        value={JSON.stringify(
          lines.map((line) => ({
            variantId: line.variantId,
            quantityOrdered: line.quantityOrdered,
            unitCost: line.unitCost,
          }))
        )}
      />

      <p className="text-sm text-neutral-500">
        The order is created as a draft. It has to be approved before stock can be received against it.
      </p>

      <SubmitButton pendingText="Creating…" className="self-start px-6">
        Create draft order
      </SubmitButton>
    </form>
  );
}
