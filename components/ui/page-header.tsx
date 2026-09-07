import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

/**
 * The shared page-title block: a title, an optional one-line description,
 * and a slot for the page's primary action button(s) — "Add Product",
 * "New sale", "Save" — all aligned the same way everywhere instead of
 * each page hand-rolling its own <h1> and button row. Stacks the actions
 * below the title on narrow screens so a wide action row never pushes the
 * title off-screen or forces horizontal scroll.
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 dark:text-white sm:text-2xl">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}