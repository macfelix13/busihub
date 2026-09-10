const CATEGORIES = [
  "Retail",
  "Boutiques",
  "Salons",
  "Barbershops",
  "Restaurants",
  "Pharmacies",
  "Service businesses",
];

/**
 * Deliberately categories, not logos. The spec is explicit that this
 * page must not invent customer names, logos, or usage numbers — there
 * are none to show yet — so this section earns its place by naming the
 * kinds of businesses Busihub is built for instead of fabricating social
 * proof.
 */
export function TrustBar() {
  return (
    <section className="border-y border-neutral-200 bg-canvas dark:border-neutral-800 dark:bg-neutral-900/40">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-5 py-8 text-center sm:px-6">
        <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
          One platform for your everyday business operations
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
          {CATEGORIES.map((category, i) => (
            <span key={category} className="flex items-center gap-3">
              <span className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">{category}</span>
              {i < CATEGORIES.length - 1 ? <span className="text-neutral-300 dark:text-neutral-700">•</span> : null}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}