/**
 * Shown while the dashboard's queries run.
 *
 * The shape matches the real page — filter row, four cards, a chart, two
 * panels — so the layout does not jump when the figures arrive. It is
 * deliberately grey and numberless: a skeleton that shows a plausible
 * total for a fraction of a second is a lie a shopkeeper might act on.
 *
 * Uses the shared SkeletonBlock (components/ui/skeleton.tsx) rather than
 * a local duplicate of the same "grey pulsing rounded box" component this
 * file previously defined itself.
 */

import { SkeletonBlock, SkeletonPage } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <SkeletonPage label="Loading your figures…">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SkeletonBlock className="h-9 w-56" />
        <SkeletonBlock className="h-9 w-32" />
      </div>

      <SkeletonBlock className="h-10 w-full max-w-md" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SkeletonBlock className="h-24" />
        <SkeletonBlock className="h-24" />
        <SkeletonBlock className="h-24" />
        <SkeletonBlock className="h-24" />
      </div>

      <SkeletonBlock className="h-64" />

      <div className="grid gap-4 lg:grid-cols-2">
        <SkeletonBlock className="h-56" />
        <SkeletonBlock className="h-56" />
      </div>
    </SkeletonPage>
  );
}