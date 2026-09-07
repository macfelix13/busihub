import { Search, ScanLine, Wallet, TrendingUp, Receipt } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * A hand-built illustration of the Till screen, styled with the same
 * cards/badges/brand color used across the real app — not a screenshot,
 * since the repo has no product photography or screenshot assets to
 * pull from (confirmed: public/ only holds a manifest and an empty
 * icons/ placeholder). The layout mirrors the real till (search, cart
 * lines, a running total, checkout) and the real dashboard's vocabulary
 * (Today's sales, Net total) rather than inventing UI that doesn't exist
 * in the product.
 */
export function HeroMockup() {
  return (
    <div className="relative mx-auto w-full max-w-lg lg:mx-0">
      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl shadow-neutral-900/10 dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-black/30">
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <span className="text-sm font-semibold text-neutral-900 dark:text-white">Till — Main branch</span>
          <Badge variant="brand">Cashier: Ama</Badge>
        </div>

        <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <div className="flex flex-1 items-center gap-2 rounded-xl border border-neutral-300 bg-neutral-50 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800">
            <Search className="h-4 w-4 shrink-0 text-neutral-400" />
            <span className="text-sm text-neutral-400">Search or scan a product…</span>
          </div>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
            <ScanLine className="h-5 w-5" />
          </div>
        </div>

        <div className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-800">
          {[
            { name: "Jollof rice (large)", qty: 2, price: "GH₵ 45.00" },
            { name: "Bottled water 500ml", qty: 3, price: "GH₵ 9.00" },
            { name: "Fried chicken (2 pcs)", qty: 1, price: "GH₵ 30.00" },
          ].map((line) => (
            <div key={line.name} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <div>
                <p className="font-medium text-neutral-800 dark:text-neutral-100">{line.name}</p>
                <p className="text-xs text-neutral-500">Qty {line.qty}</p>
              </div>
              <span className="font-medium text-neutral-700 dark:text-neutral-300">{line.price}</span>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/60">
          <span className="text-sm font-medium text-neutral-600 dark:text-neutral-300">Total</span>
          <span className="text-lg font-semibold text-neutral-900 dark:text-white">GH₵ 84.00</span>
        </div>

        <div className="grid grid-cols-2 gap-2 p-4">
          <div className="flex items-center justify-center gap-2 rounded-xl border border-neutral-300 py-2.5 text-sm font-medium text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
            <Wallet className="h-4 w-4" /> Cash
          </div>
          <div className="flex items-center justify-center gap-2 rounded-xl bg-brand-600 py-2.5 text-sm font-medium text-white">
            Mobile Money
          </div>
        </div>
      </div>

      {/* Secondary "today" card, floating over the till — the dashboard
          layer the spec asks for, kept small so it reads as a companion
          view rather than a second competing screen. */}
      <div className="absolute -bottom-8 -left-6 hidden w-56 rounded-2xl border border-neutral-200 bg-white p-4 shadow-lg shadow-neutral-900/10 dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-black/30 sm:block">
        <div className="flex items-center gap-2 text-xs font-medium text-neutral-500">
          <TrendingUp className="h-3.5 w-3.5" /> Today&apos;s sales
        </div>
        <p className="mt-1 text-2xl font-semibold text-neutral-900 dark:text-white">GH₵ 2,340</p>
        <div className="mt-2 flex items-center gap-1.5 text-xs text-neutral-500">
          <Receipt className="h-3.5 w-3.5" /> 38 transactions
        </div>
      </div>
    </div>
  );
}