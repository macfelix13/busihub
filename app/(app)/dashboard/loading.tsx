/**
 * Shown while the dashboard's queries run.
 *
 * The shape matches the real page — filter row, four cards, a chart, two
 * panels — so the layout does not jump when the figures arrive. It is
 * deliberately grey and numberless: a skeleton that shows a plausible
 * total for a fraction of a second is a lie a shopkeeper might act on.
 */

function Block({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-2xl bg-neutral-100 dark:bg-neutral-800 ${className}`} />;
}

export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your figures…</span>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Block className="h-9 w-56" />
        <Block className="h-9 w-32" />
      </div>

      <Block className="h-10 w-full max-w-md" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Block className="h-24" />
        <Block className="h-24" />
        <Block className="h-24" />
        <Block className="h-24" />
      </div>

      <Block className="h-64" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Block className="h-56" />
        <Block className="h-56" />
      </div>
    </div>
  );
}