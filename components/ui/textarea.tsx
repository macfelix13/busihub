"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  error?: string;
}

/** Labeled textarea, styled to match components/ui/field.tsx. */
export function Textarea({ label, error, className, id, rows = 3, ...props }: TextareaProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
        {label}
      </label>
      <textarea
        id={inputId}
        rows={rows}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          "rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900",
          "focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30",
          "dark:border-neutral-700 dark:bg-neutral-900 dark:text-white",
          error && "border-red-500 focus:border-red-500 focus:ring-red-500/30",
          className
        )}
        {...props}
      />
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

