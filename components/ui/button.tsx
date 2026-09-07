"use client";

import { forwardRef } from "react";
import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

type Variant = "primary" | "secondary" | "danger" | "ghost";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /**
   * Shows a spinner before the button's contents and disables the button
   * (in addition to whatever `disabled` was already passed) — the fix for
   * every "Save"/"Checkout"/etc. button that could previously be clicked a
   * second time while the first click was still in flight. Purely
   * additive and optional: every existing <Button> call, with no `loading`
   * prop, renders exactly as it did before.
   */
  loading?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 focus-visible:outline-brand-600",
  secondary:
    "bg-white text-neutral-900 border border-neutral-300 hover:bg-neutral-50 focus-visible:outline-neutral-400 dark:bg-neutral-900 dark:text-white dark:border-neutral-700",
  danger: "bg-red-600 text-white hover:bg-red-700 focus-visible:outline-red-600",
  ghost: "bg-transparent text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", disabled, loading = false, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-[color,background-color,border-color,transform] duration-150",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "active:scale-[0.98] motion-reduce:active:scale-100",
        variantClasses[variant],
        className
      )}
      {...props}
    >
      {loading ? <Spinner className="h-4 w-4" /> : null}
      {children}
    </button>
  );
});

/**
 * Submit button that shows a pending state driven by the enclosing
 * <form>'s Server Action — now a spinner alongside `pendingText` (e.g.
 * "[spinner] Saving…") rather than pendingText alone, and still disabled
 * for the same duration as before, so a form's Server Action can't be
 * double-submitted by an impatient second click.
 */
export function SubmitButton({
  children,
  pendingText,
  ...props
}: ButtonProps & { pendingText?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} {...props}>
      {pending ? pendingText ?? "Please wait…" : children}
    </Button>
  );
}