import { SkeletonBlock, SkeletonPage } from "@/components/ui/skeleton";

/** Covers /sales and, as a fallback, any nested sale route that has no more specific loading.tsx of its own. */
export default function SalesLoading() {
  return (
    <SkeletonPage label="Loading sales…">
      <div className="flex items-center justify-between gap-3">
        <SkeletonBlock className="h-9 w-40" />
        <SkeletonBlock className="h-10 w-32" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-20" />
        ))}
      </div>
      <SkeletonBlock className="h-10 w-72" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-16" />
        ))}
      </div>
    </SkeletonPage>
  );
}
