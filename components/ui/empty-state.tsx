import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

/**
 * The shared "nothing here yet" panel. Before this, an empty list page
 * either showed a bare one-line sentence or nothing at all — no icon, no
 * next step. Wiring this into any given page's empty branch is a
 * page-by-page follow-up, not part of adding the component itself.
 */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-neutral-200 px-6 py-12 text-center dark:border-surface-line",
        className
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-neutral-100 text-neutral-400 dark:bg-surface dark:text-ink-muted">
        <Icon className="h-6 w-6" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-neutral-900 dark:text-ink">{title}</p>
        {description ? (
          <p className="max-w-sm text-sm text-neutral-500 dark:text-ink-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}