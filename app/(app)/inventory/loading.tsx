import { SkeletonBlock, SkeletonPage } from "@/components/ui/skeleton";

/** Covers /inventory and, as a fallback, its nested adjust/count/receive/[variantId] routes. */
export default function InventoryLoading() {
  return (
    <SkeletonPage label="Loading inventory…">
      <div className="flex items-center justify-between gap-3">
        <SkeletonBlock className="h-9 w-48" />
        <SkeletonBlock className="h-10 w-32" />
      </div>
      <SkeletonBlock className="h-10 w-72" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-14" />
        ))}
      </div>
    </SkeletonPage>
  );
}
