import { cn } from "@/lib/utils";

export type BadgeVariant = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

/**
 * Small status pill — for order/payment/stock status, and anywhere else a
 * page currently just prints a plain colored word. Uses Tailwind's stock
 * green/amber/red/blue scales rather than inventing a parallel set of
 * semantic color tokens: this app's `danger` already means `red-600`
 * (components/ui/button.tsx, and every inline form-error box), so this
 * reuses that instead of introducing a second name for the same color.
 */
const variantClasses: Record<BadgeVariant, string> = {
  neutral: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  brand: "bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300",
  success: "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  danger: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300",
  info: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
};

export function Badge({
  variant = "neutral",
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium",
        variantClasses[variant],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}