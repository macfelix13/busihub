"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Button, SubmitButton } from "@/components/ui/button";
import { formatQuantity } from "@/lib/validation/inventory";
import type { FormState } from "./actions";

const initialState: FormState = {};

export interface ReceiveLine {
  itemId: string;
  label: string;
  ordered: number;
  received: number;
}

interface ReceiveFormProps {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  lines: ReceiveLine[];
}

export function ReceiveForm({ action, lines }: ReceiveFormProps) {
  const [state, formAction] = useFormState(action, initialState);
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.itemId, ""]))
  );

  /** "Everything on this order turned up" — the common case, one click. */
  function fillOutstanding() {
    setQuantities(
      Object.fromEntries(
        lines.map((l) => {
          const outstanding = l.ordered - l.received;
          return [l.itemId, outstanding > 0 ? String(Number(outstanding.toFixed(3))) : ""];
        })
      )
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">Enter how much of each item actually arrived. Leave a line blank if none did.</p>
        <Button type="button" variant="secondary" onClick={fillOutstanding}>
          Receive all outstanding
        </Button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase text-neutral-500 dark:border-neutral-800">
              <tr>
                <th className="px-4 py-3 font-medium">Product</th>
                <th className="px-4 py-3 text-right font-medium">Ordered</th>
                <th className="px-4 py-3 text-right font-medium">Already in</th>
                <th className="px-4 py-3 text-right font-medium">Outstanding</th>
                <th className="px-4 py-3 font-medium">Receiving now</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {lines.map((line, index) => {
                const outstanding = line.ordered - line.received;
                return (
                  <tr key={line.itemId}>
                    <td className="px-4 py-3 font-medium">{line.label}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatQuantity(line.ordered)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-neutral-500">{formatQuantity(line.received)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatQuantity(outstanding)}</td>
                    <td className="px-4 py-3">
                      <Field
                        label=""
                        aria-label={`Quantity received for ${line.label}`}
                        type="number"
                        step="0.001"
                        min={0}
                        max={outstanding}
                        className="w-32"
                        value={quantities[line.itemId] ?? ""}
                        onChange={(e) => setQuantities((q) => ({ ...q, [line.itemId]: e.target.value }))}
                        error={state.fieldErrors?.[`receipts.${index}.quantity`]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Textarea label="Delivery note (optional)" name="note" error={state.fieldErrors?.note} />

      <input
        type="hidden"
        name="receiptsJson"
        value={JSON.stringify(lines.map((l) => ({ itemId: l.itemId, quantity: quantities[l.itemId] ?? "" })))}
      />

      <SubmitButton pendingText="Recording…" className="self-start px-6">
        Record delivery
      </SubmitButton>
    </form>
  );
}