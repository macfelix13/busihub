"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  /** Optional element rendered beside the input (e.g. a "Scan" button next to a barcode field) — the input row becomes a flex row when this is set; omit for the plain single-input layout every other caller already uses. */
  trailing?: React.ReactNode;
}

/** Labeled input with an accessible error association (aria-describedby). */
export function Field({ label, error, className, id, trailing, ...props }: FieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;

  const input = (
    <input
      id={inputId}
      aria-invalid={Boolean(error)}
      aria-describedby={error ? errorId : undefined}
      className={cn(
        // Dark mode retuned 2026-09-11: bg/border are now the same
        // secondary-surface/border tokens the brand spec calls for on
        // inputs (surface, not surface-card — an input reads as sitting
        // IN a card, not as its own card), and focus uses the lime accent
        // instead of brand-500's green, matching every other focus ring
        // in the app (see components/layout/sidebar.tsx's FOCUS_RING).
        "min-h-[44px] rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 placeholder:text-neutral-400",
        "focus:border-lime-500 focus:outline-none focus:ring-2 focus:ring-lime-400/40",
        "dark:border-surface-line dark:bg-surface dark:text-ink dark:placeholder:text-ink-muted/70",
        error && "border-red-500 focus:border-red-500 focus:ring-red-500/30",
        trailing && "min-w-0 flex-1",
        className
      )}
      {...props}
    />
  );

  return (
    <div className="flex flex-col gap-1.5">
      {/* A caller that labels the field some other way (an aria-label on a
          dense table row, say) passes "" — render no label element at all
          rather than an empty one that still takes up its gap. */}
      {label ? (
        <label htmlFor={inputId} className="text-sm font-medium text-neutral-800 dark:text-ink">
          {label}
        </label>
      ) : null}
      {trailing ? (
        <div className="flex gap-2">
          {input}
          {trailing}
        </div>
      ) : (
        input
      )}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}