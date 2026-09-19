"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  description?: string;
}

/** Labeled checkbox for boolean settings toggles, styled to match Field/Select. */
export function Checkbox({ label, description, className, id, ...props }: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className={cn("flex items-start gap-3", className)}>
      <input
        id={inputId}
        type="checkbox"
        // text-brand-700, not text-brand-950 — this is the checkbox's own
        // checked-state fill color (a native <input> reads `text-*` for
        // that), which sits on plain white/surface backgrounds rather
        // than the dark sidebar 950 pairs with elsewhere, so it can
        // safely be part of the dynamic Primary-color ramp like the rest
        // of `brand` (see tailwind.config.ts's comment on that family).
        className="mt-0.5 h-5 w-5 shrink-0 rounded border-neutral-300 text-brand-700 focus:ring-2 focus:ring-brand-500/30 dark:border-surface-line dark:bg-surface"
        {...props}
      />
      <label htmlFor={inputId} className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-neutral-800 dark:text-ink">{label}</span>
        {description ? (
          <span className="text-sm text-neutral-500 dark:text-ink-muted">{description}</span>
        ) : null}
      </label>
    </div>
  );
}