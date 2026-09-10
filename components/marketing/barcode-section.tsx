import { ScanBarcode, Smartphone, ArrowRight, Search, ShoppingCart, CreditCard } from "lucide-react";
import { SectionHeading } from "./section-heading";

const FLOW = [ScanBarcode, Search, ShoppingCart, CreditCard];
const FLOW_LABELS = ["Barcode", "Product found", "Added to cart", "Checkout"];

export function BarcodeSection() {
  return (
    <section id="barcode" className="border-t border-neutral-200 bg-canvas dark:border-neutral-800 dark:bg-neutral-900/40">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
        <SectionHeading eyebrow="Barcode scanning" title="Scan. Sell. Done." />

        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
              <ScanBarcode className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-neutral-900 dark:text-white">Barcode scanner</h3>
            <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400">
              Plug in a supported USB or Bluetooth barcode scanner and scan products straight into the cart.
            </p>
          </div>
          <div className="rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
              <Smartphone className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-neutral-900 dark:text-white">Phone camera</h3>
            <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400">
              No scanner? Use a compatible phone&apos;s camera to scan a product&apos;s barcode instead.
            </p>
          </div>
        </div>

        <div className="mx-auto mt-10 flex max-w-3xl flex-wrap items-center justify-center gap-x-1 gap-y-6">
          {FLOW.map((Icon, i) => (
            <div key={FLOW_LABELS[i]} className="flex items-center gap-1">
              <div className="flex w-24 flex-col items-center gap-2">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-neutral-200 bg-white text-brand-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-brand-300">
                  <Icon className="h-5 w-5" />
                </div>
                <span className="text-center text-xs font-medium leading-tight text-neutral-600 dark:text-neutral-300">
                  {FLOW_LABELS[i]}
                </span>
              </div>
              {i < FLOW.length - 1 ? <ArrowRight className="h-4 w-4 shrink-0 text-neutral-300 dark:text-neutral-700" /> : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}