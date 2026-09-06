"use client";

import { useState, useTransition } from "react";
import { SubmitButton, Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export interface StatusToggleConfirm {
  title: string;
  description?: string;
  confirmLabel?: string;
}

/**
 * Wraps a bound plain (no-useFormState) status-change action as a
 * one-button form — same pattern as branches/set-main-branch-button.tsx.
 *
 * `confirm` is new (Section: Services page) and strictly OPTIONAL,
 * defaulting to undefined/off — this component is shared by nine other
 * call sites across the app (sales, staff, admin businesses, suppliers,
 * purchase orders, awaiting-payment, payment settings, customers, plus
 * products/services itself) that were never asked for a confirmation
 * step, and the master spec is explicit about not touching unrelated
 * functionality. Passing nothing here reproduces the exact old
 * immediate-fire `<form action={action}>` behaviour, byte for byte.
 *
 * When `confirm` IS given, the button opens a dialog instead of
 * submitting a form, and the bound action is called directly inside a
 * transition on confirm — a bound server action works as a plain async
 * function, not only as a `<form action={fn}>` target.
 */
export function StatusToggleButton({
  action,
  label,
  pendingLabel,
  variant = "secondary",
  confirm,
}: {
  action: () => Promise<void>;
  label: string;
  pendingLabel: string;
  variant?: "secondary" | "danger" | "ghost";
  /** Opt in to an "are you sure?" step before the action runs. */
  confirm?: StatusToggleConfirm;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!confirm) {
    return (
      <form action={action}>
        <SubmitButton variant={variant} pendingText={pendingLabel}>
          {label}
        </SubmitButton>
      </form>
    );
  }

  return (
    <>
      <Button type="button" variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        title={confirm.title}
        description={confirm.description}
        confirmLabel={confirm.confirmLabel ?? label}
        confirmVariant={variant === "secondary" ? "primary" : variant}
        pending={pending}
        pendingLabel={pendingLabel}
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          startTransition(async () => {
            await action();
            setOpen(false);
          });
        }}
      />
    </>
  );
}