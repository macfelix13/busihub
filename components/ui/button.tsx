"use client";

import { forwardRef } from "react";
import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

type Variant = "primary" | "secondary" | "outline" | "danger" | "ghost";

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
  // Retuned 2026-09-11: this was bg-brand-950 (dark green, matching the
  // sidebar) — the brand spec calls for the app's one "do the main
  // thing" color to be the lime accent instead, so every primary action
  // (Complete Sale, Save, Add Product, Pay) now reads unmistakably as
  // THE thing to do next, with the dark green reserved for structural
  // chrome (sidebar, cards) rather than competing with it for attention.
  primary: "bg-lime-400 text-brand-950 hover:bg-lime-300 focus-visible:outline-lime-400",
  secondary:
    "bg-white text-neutral-900 border border-neutral-300 hover:bg-neutral-50 focus-visible:outline-neutral-400 dark:border-surface-line dark:bg-surface dark:text-ink dark:hover:bg-surface-card",
  // New 2026-09-11: transparent-background, bordered button — for a
  // secondary action that shouldn't read as a filled surface at all
  // (e.g. sitting next to a primary CTA without competing with it).
  outline:
    "border border-neutral-300 bg-transparent text-neutral-700 hover:bg-neutral-100 focus-visible:outline-neutral-400 dark:border-surface-line dark:text-ink dark:hover:bg-surface/60",
  danger: "bg-red-600 text-white hover:bg-red-700 focus-visible:outline-red-600",
  ghost: "bg-transparent text-neutral-700 hover:bg-neutral-100 dark:text-ink-muted dark:hover:bg-surface/60",
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