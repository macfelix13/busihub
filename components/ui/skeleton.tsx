/**
 * A single grey, pulsing placeholder block, shared by every route's
 * loading.tsx (dashboard/loading.tsx originated this pattern; this file
 * just gives the rest of the app the same component instead of each
 * route redefining it slightly differently).
 *
 * Deliberately plain: no placeholder numbers, no fake row of text that
 * could be mistaken for a real name or amount for the instant before the
 * real data arrives. A skeleton that looks too finished is a skeleton
 * someone will act on by mistake.
 */
export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-2xl bg-neutral-100 dark:bg-neutral-800 ${className}`} />;
}

/** Wraps a route's skeleton with the accessibility announcement every loading.tsx needs. */
export function SkeletonPage({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
