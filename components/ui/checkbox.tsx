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
        className="mt-0.5 h-5 w-5 shrink-0 rounded border-neutral-300 text-brand-600 focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900"
        {...props}
      />
      <label htmlFor={inputId} className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">{label}</span>
        {description ? (
          <span className="text-sm text-neutral-500 dark:text-neutral-400">{description}</span>
        ) : null}
      </label>
    </div>
  );
}
