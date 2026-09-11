"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import { PackageCheck } from "lucide-react";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { formatQuantity } from "@/lib/validation/inventory";
import { REFUND_METHODS } from "@/lib/validation/refunds";
import type { FormState } from "./actions";

const initialState: FormState = {};

export interface RefundableLine {
  saleItemId: string;
  description: string;
  sku: string | null;
  sold: number;
  alreadyRefunded: number;
  unitPrice: number;
  /** What one unit of this line was actually charged, tax included. */
  unitTotal: number;
  /** A service never carries stock (migration 0040) — create_refund
   *  forces restock to false for one regardless of what's sent, so the
   *  checkbox is replaced with a static note rather than offering a
   *  choice that can't actually take effect. */
  isService?: boolean;
}

interface RefundFormProps {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  lines: RefundableLine[];
  currencyCode: string;
  /** A walk-in sale has no account to credit, so cash is the only option. */
  hasCustomer: boolean;
}

interface LineState {
  quantity: string;
  restock: boolean;
}

export function RefundForm({ action, lines, currencyCode, hasCustomer }: RefundFormProps) {
  const [state, formAction] = useFormState(action, initialState);
  const [rows, setRows] = useState<Record<string, LineState>>(() =>
    Object.fromEntries(lines.map((l) => [l.saleItemId, { quantity: "", restock: !l.isService }]))
  );

  function patch(saleItemId: string, next: Partial<LineState>) {
    setRows((r) => ({ ...r, [saleItemId]: { ...(r[saleItemId] ?? { quantity: "", restock: true }), ...next } }));
  }

  // A preview. create_refund apportions the real amounts from the
  // original sale line, so this is what the customer should see coming
  // back — not what determines it.
  const estimated = lines.reduce((sum, line) => {
    const qty = Number(rows[line.saleItemId]?.quantity ?? "");
    return sum + (Number.isFinite(qty) && qty > 0 ? line.unitTotal * qty : 0);
  }, 0);

  const refundable = lines.filter((l) => l.sold - l.alreadyRefunded > 0);

  if (refundable.length === 0) {
    return <EmptyState icon={PackageCheck} title="Everything on this sale has already been returned." />;
  }

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase text-neutral-500 dark:border-surface-line dark:text-ink-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Item</th>
                <th className="px-4 py-3 text-right font-medium">Sold</th>
                <th className="px-4 py-3 text-right font-medium">Already back</th>
                <th className="px-4 py-3 font-medium">Returning</th>
                <th className="px-4 py-3 font-medium">Condition</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-surface-line">
              {lines.map((line, index) => {
                const outstanding = line.sold - line.alreadyRefunded;
                const row = rows[line.saleItemId] ?? { quantity: "", restock: true };
                return (
                  <tr
                    key={line.saleItemId}
                    className={`transition-colors hover:bg-neutral-50 dark:hover:bg-surface/60 ${
                      outstanding <= 0 ? "opacity-50" : ""
                    }`}
                  >
                    <td className="px-4 py-3">
                      <span className="font-medium">{line.description}</span>
                      {line.sku ? (
                        <span className="ml-2 text-neutral-500 dark:text-ink-muted">{line.sku}</span>
                      ) : null}
                      <p className="text-xs text-neutral-500 dark:text-ink-muted">
                        {formatMoney(toMinorUnits(line.unitTotal), currencyCode)} each as sold
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatQuantity(line.sold)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-neutral-500 dark:text-ink-muted">
                      {formatQuantity(line.alreadyRefunded)}
                    </td>
                    <td className="px-4 py-3">
                      <Field
                        label=""
                        aria-label={`Quantity returned for ${line.description}`}
                        type="number"
                        step="0.001"
                        min={0}
                        max={outstanding}
                        disabled={outstanding <= 0}
                        className="w-28"
                        value={row.quantity}
                        onChange={(e) => patch(line.saleItemId, { quantity: e.target.value })}
                        error={state.fieldErrors?.[`lines.${index}.quantity`]}
                      />
                    </td>
                    <td className="px-4 py-3">
                      {line.isService ? (
                        <span className="text-sm text-neutral-500 dark:text-ink-muted">— (service)</span>
                      ) : (
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={row.restock}
                            disabled={outstanding <= 0}
                            onChange={(e) => patch(line.saleItemId, { restock: e.target.checked })}
                            className="h-5 w-5 rounded border-neutral-300 text-brand-600 focus:ring-2 focus:ring-brand-500/30 dark:border-surface-line dark:bg-surface"
                          />
                          <span className="text-neutral-600 dark:text-ink-muted">Back on the shelf</span>
                        </label>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-sm text-neutral-500 dark:text-ink-muted">
        Untick &ldquo;back on the shelf&rdquo; for damaged goods — the customer is still refunded, but the stock
        doesn&apos;t return.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="How is the money going back?"
          name="method"
          defaultValue={hasCustomer ? "credit" : "cash"}
          error={state.fieldErrors?.method}
          options={
            hasCustomer
              ? REFUND_METHODS.map((m) => ({ value: m.value, label: m.label }))
              : [{ value: "cash", label: "Cash back" }]
          }
        />
        <div className="flex items-end">
          <div className="w-full rounded-xl bg-neutral-100 px-3.5 py-2.5 dark:bg-surface">
            <span className="text-sm text-neutral-600 dark:text-ink-muted">Roughly </span>
            <span className="font-semibold tabular-nums">
              {formatMoney(toMinorUnits(estimated), currencyCode)}
            </span>
            <p className="text-xs text-neutral-500 dark:text-ink-muted">Exact amount is worked out from the original sale.</p>
          </div>
        </div>
      </div>

      <Textarea label="Reason (optional)" name="reason" error={state.fieldErrors?.reason} />

      <input
        type="hidden"
        name="linesJson"
        value={JSON.stringify(
          lines.map((l) => ({
            saleItemId: l.saleItemId,
            quantity: rows[l.saleItemId]?.quantity ?? "",
            restock: rows[l.saleItemId]?.restock ?? true,
          }))
        )}
      />

      <SubmitButton pendingText="Recording…" className="self-start px-6">
        Record return
      </SubmitButton>
    </form>
  );
}