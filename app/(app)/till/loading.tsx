import { SkeletonBlock, SkeletonPage } from "@/components/ui/skeleton";

/**
 * The till is the single most-visited screen in the app — reloaded after
 * every sale — and until now it had no loading state at all: it fires
 * five-plus queries (branch, catalogue, customers, settings, momo check)
 * and rendered nothing until every one of them finished, which on a slow
 * mobile connection looks exactly like a frozen page. This just says
 * "the till is coming," in the same two-pane shape the real one loads
 * into, so a cashier is not left staring at blank white wondering whether
 * to tap again.
 */
export default function TillLoading() {
  return (
    <SkeletonPage label="Loading the till…">
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div>
          <SkeletonBlock className="mb-4 h-11 w-full" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <SkeletonBlock key={i} className="h-24" />
            ))}
          </div>
        </div>
        <SkeletonBlock className="h-[32rem]" />
      </div>
    </SkeletonPage>
  );
}
