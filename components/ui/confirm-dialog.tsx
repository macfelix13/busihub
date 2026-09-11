"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Matches Button's own variant set (components/ui/button.tsx) — no "default". */
  confirmVariant?: "primary" | "secondary" | "danger" | "ghost";
  /** Disables both buttons and swaps the confirm label while the action runs. */
  pending?: boolean;
  pendingLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A shared "are you sure?" dialog — the first one in Busihub (Section:
 * code quality review found no existing modal/toast component anywhere;
 * the one prior precedent, expenses/void-form.tsx's two-step reveal, is
 * bespoke to that form, not reusable). Added for Products and Services'
 * delete/deactivate actions, per the user's own choice to add it to both
 * rather than to every destructive action across the app.
 *
 * Deliberately plain — no portal, no focus trap library, no animation —
 * matching this codebase's existing UI components (Field, Select,
 * Textarea, Button), which are all similarly unadorned. It IS keyboard
 * accessible: Escape cancels, the dialog is announced via
 * role="alertdialog", and the confirm button receives focus on open so a
 * keyboard/switch user isn't left hunting for it.
 *
 * A courtesy layer only, same as every other client-side UI decision in
 * this app — the server action bound into the confirming button still
 * re-checks the caller's permission itself; this dialog cannot be the
 * reason an unauthorized change goes through, only the reason an
 * authorized one doesn't happen by accident.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "danger",
  pending = false,
  pendingLabel = "Working…",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !pending && onCancel()}
      aria-hidden={false}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={description ? "confirm-dialog-description" : undefined}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-surface-card"
      >
        <h2 id="confirm-dialog-title" className="text-lg font-semibold">
          {title}
        </h2>
        {description ? (
          <p id="confirm-dialog-description" className="mt-2 text-sm text-neutral-600 dark:text-ink-muted">
            {description}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            variant={confirmVariant}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}