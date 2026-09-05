import { SkeletonBlock, SkeletonPage } from "@/components/ui/skeleton";

/** Covers /reports and, as a fallback, all four report pages beneath it. */
export default function ReportsLoading() {
  return (
    <SkeletonPage label="Loading your figures…">
      <SkeletonBlock className="h-9 w-40" />
      <SkeletonBlock className="h-10 w-full max-w-md" />
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-24" />
        ))}
      </div>
      <SkeletonBlock className="h-56" />
    </SkeletonPage>
  );
}
