import { cn } from "@/lib/utils";

/**
 * The shared card shell — so "card" means exactly one border radius, one
 * border color, one background, and one padding scale everywhere it's
 * used, rather than every page picking its own combination of
 * rounded-xl/rounded-2xl, border-neutral-200/300, and ad-hoc padding
 * (which is what most pages did before this).
 *
 * Deliberately plain, composable pieces (Card + optional
 * Header/Title/Description/Content/Footer) rather than one big prop-heavy
 * component — a page that just needs a plain box uses <Card> alone with
 * its own padding; a page that needs a titled section composes the rest.
 */
export function Card({
  className,
  hoverable = false,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  /** Subtle shadow-on-hover, for cards that are themselves clickable (a KPI card linking to its detail page, a list row rendered as a card on mobile) — not for cards that just hold static content. */
  hoverable?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-neutral-200 bg-white transition-shadow duration-150 dark:border-neutral-800 dark:bg-neutral-900",
        hoverable && "hover:shadow-md hover:shadow-neutral-900/5 dark:hover:shadow-black/30",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col gap-1 border-b border-neutral-200 px-5 py-4 dark:border-neutral-800", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn("text-base font-semibold text-neutral-900 dark:text-white", className)} {...props}>
      {children}
    </h3>
  );
}

export function CardDescription({ className, children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-sm text-neutral-500 dark:text-neutral-400", className)} {...props}>
      {children}
    </p>
  );
}

export function CardContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("px-5 py-4", className)} {...props}>
      {children}
    </div>
  );
}

export function CardFooter({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-t border-neutral-200 px-5 py-4 dark:border-neutral-800",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}