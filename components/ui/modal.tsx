"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  /** Set while an action inside the modal is in flight — suppresses the
   *  backdrop-click, Escape, and close-button paths so a pending save
   *  can't be interrupted out from under itself. Mirrors the same
   *  `pending` idea confirm-dialog.tsx already uses. */
  pending?: boolean;
}

const sizeClasses = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" };

/**
 * The general-purpose modal shell this app didn't have — confirm-dialog.tsx
 * covers only yes/no confirmations; this is for everything else that
 * needs a floating panel with real content (a form, a detail view).
 * Deliberately built the same way ConfirmDialog already was — no portal,
 * no focus-trap library — matching the one modal pattern already proven
 * out in this codebase rather than introducing a second one.
 *
 * Existing bespoke modals (BarcodeScannerModal, till.tsx's No-Sale
 * dialog) are left exactly as they are for now; migrating them onto this
 * shell, if ever worth doing, is a separate follow-up, not part of adding
 * the component itself.
 *
 * On mobile this behaves as a bottom sheet (slides up, rounded top
 * corners only, anchored to the bottom of the viewport) rather than a
 * centered box — easier to reach one-handed and impossible to render
 * partly off-screen on a short viewport. At sm: and up it's a centered,
 * fully-rounded dialog.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  pending = false,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const focusable = panelRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    focusable?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 animate-fade-in sm:items-center sm:p-4"
      onClick={() => !pending && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby={description ? "modal-description" : undefined}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          // Dark mode retuned 2026-09-11 to the same surface-card /
          // surface-line elevation tokens used by Card — see
          // tailwind.config.ts's `surface` comment.
          "flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl animate-slide-up dark:bg-surface-card sm:rounded-2xl",
          sizeClasses[size]
        )}
      >
        <div className="flex flex-shrink-0 items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4 dark:border-surface-line">
          <div className="min-w-0">
            <h2 id="modal-title" className="text-base font-semibold text-neutral-900 dark:text-ink">
              {title}
            </h2>
            {description ? (
              <p id="modal-description" className="mt-0.5 text-sm text-neutral-500 dark:text-ink-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => !pending && onClose()}
            aria-label="Close"
            disabled={pending}
            className="flex-shrink-0 rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-ink-muted dark:hover:bg-surface"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2 border-t border-neutral-200 px-5 py-4 dark:border-surface-line">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}