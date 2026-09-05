import { SkeletonBlock, SkeletonPage } from "@/components/ui/skeleton";

/** Covers /customers and, as a fallback, its nested detail/charge/payment/edit routes. */
export default function CustomersLoading() {
  return (
    <SkeletonPage label="Loading customers…">
      <div className="flex items-center justify-between gap-3">
        <SkeletonBlock className="h-9 w-40" />
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
