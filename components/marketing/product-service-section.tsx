import { Check, Package, Sparkles } from "lucide-react";
import { SectionHeading } from "./section-heading";

/**
 * Both halves of this card are real: the product catalogue and the
 * service catalogue are separate, first-class concepts in the app (see
 * the nav's "Products" group, which lists Services/Add Service alongside
 * Products/Add Product) — not one feature awkwardly repurposed for the
 * other. Neither list below claims anything the other business type is
 * forced into (e.g. a salon is never made to track stock it doesn't
 * have).
 */
export function ProductServiceSection() {
  return (
    <section id="solutions" className="border-t border-neutral-200 dark:border-surface-line">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
        <SectionHeading
          eyebrow="Products & services"
          title="Not just for products. Built for services too."
          description="Whether you sell products, services, or both, Busihub adapts to the way your business actually works."
        />

        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-neutral-200 bg-white p-6 dark:border-surface-line dark:bg-surface-card sm:p-8">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
              <Package className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-neutral-900 dark:text-ink">Product businesses</h3>
            <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
              Boutiques, cosmetics shops, supermarkets, electronics, pharmacies, gift shops, and any business that
              sells physical stock.
            </p>
            <ul className="mt-5 flex flex-col gap-2.5">
              {["Full inventory tracking", "Barcode scanning", "Product variants", "Stock levels & low-stock alerts", "Product sales reporting"].map(
                (item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-neutral-700 dark:text-ink-muted">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                    {item}
                  </li>
                )
              )}
            </ul>
          </div>

          <div className="rounded-2xl border border-neutral-200 bg-white p-6 dark:border-surface-line dark:bg-surface-card sm:p-8">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
              <Sparkles className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-neutral-900 dark:text-ink">Service businesses</h3>
            <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
              Salons, barbershops, printing, photography, repairs, and other service and consulting businesses.
            </p>
            <ul className="mt-5 flex flex-col gap-2.5">
              {["A service catalogue with your own pricing", "Quick checkout — no stock to manage", "Staff & cashier tracking", "Customer records", "Sales reporting"].map(
                (item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-neutral-700 dark:text-ink-muted">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                    {item}
                  </li>
                )
              )}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}