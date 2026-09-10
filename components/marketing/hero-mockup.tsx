import { LayoutDashboard, ShoppingCart, Boxes, Users, BarChart3, Wallet, TrendingUp, Receipt } from "lucide-react";

/**
 * A hand-built illustration of the app's actual current shell, not a
 * screenshot (the repo has no product photography or screenshot assets to
 * pull from: public/ only holds a manifest and an empty icons/
 * placeholder) — but every color and structural element here is copied
 * class-for-class from the real app rather than invented: the dark green
 * sidebar (bg-brand-950) and lime logo badge/active-nav highlight from
 * components/layout/sidebar.tsx, and the off-white canvas content area,
 * white stat cards, dark "hero" stat card and dark-green primary button
 * from app/(app)/dashboard/page.tsx. Showing visitors the app's previous,
 * lighter-brand-green look here would be actively misleading now that the
 * app itself has moved on from it.
 */

const NAV_ITEMS = [
  { icon: LayoutDashboard, label: "Dashboard", active: true },
  { icon: ShoppingCart, label: "Till", active: false },
  { icon: Boxes, label: "Inventory", active: false },
  { icon: Users, label: "Customers", active: false },
  { icon: BarChart3, label: "Reports", active: false },
];

const LATEST_SALES = [
  { name: "Jollof rice (large)", amount: "GH₵ 45.00" },
  { name: "Bottled water 500ml", amount: "GH₵ 9.00" },
  { name: "Fried chicken (2 pcs)", amount: "GH₵ 30.00" },
];

export function HeroMockup() {
  return (
    <div className="relative mx-auto w-full max-w-lg lg:mx-0">
      <div className="flex overflow-hidden rounded-2xl border border-neutral-200 shadow-xl shadow-neutral-900/10 dark:border-neutral-800 dark:shadow-black/30">
        {/* Sidebar — bg-brand-950 with a lime logo badge and lime
            active-nav highlight, same treatment as
            components/layout/sidebar.tsx. */}
        <div className="flex w-36 flex-shrink-0 flex-col bg-brand-950 py-4 sm:w-40">
          <div className="flex items-center gap-2 px-3 pb-4">
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-lime-400 text-xs font-bold text-brand-950">
              B
            </span>
            <span className="truncate text-sm font-semibold text-white">Busihub</span>
          </div>
          <div className="flex flex-col gap-0.5 px-2">
            {NAV_ITEMS.map((item) => (
              <div
                key={item.label}
                className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium ${
                  item.active ? "bg-white/10 text-lime-300" : "text-brand-100"
                }`}
              >
                <item.icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                <span className="truncate">{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Content area — bg-canvas, matching the app's own main content
            background (components/layout/app-shell.tsx). */}
        <div className="flex flex-1 flex-col gap-3 bg-canvas p-4 dark:bg-canvas-dark">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-neutral-900 dark:text-white">Dashboard</span>
            <span className="rounded-lg bg-brand-950 px-2.5 py-1.5 text-[11px] font-medium text-white">
              Open the till
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {/* First card gets the dark "hero" treatment, exactly like the
                real dashboard's headline stat card. */}
            <div className="rounded-xl bg-brand-950 p-2.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-lime-400 text-brand-950">
                <Wallet className="h-3 w-3" aria-hidden="true" />
              </span>
              <p className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-brand-200">Net sales</p>
              <p className="text-sm font-semibold text-white">GH₵ 2,340</p>
            </div>
            <div className="rounded-xl border border-neutral-200/70 bg-white p-2.5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                <TrendingUp className="h-3 w-3" aria-hidden="true" />
              </span>
              <p className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">Profit</p>
              <p className="text-sm font-semibold text-neutral-900 dark:text-white">GH₵ 890</p>
            </div>
            <div className="rounded-xl border border-neutral-200/70 bg-white p-2.5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                <Receipt className="h-3 w-3" aria-hidden="true" />
              </span>
              <p className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">Sales</p>
              <p className="text-sm font-semibold text-neutral-900 dark:text-white">38</p>
            </div>
          </div>

          <div className="rounded-xl border border-neutral-200/70 bg-white p-3 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">Latest sales</p>
            <div className="mt-2 flex flex-col gap-1.5">
              {LATEST_SALES.map((line) => (
                <div key={line.name} className="flex items-center justify-between text-xs">
                  <span className="truncate text-neutral-700 dark:text-neutral-300">{line.name}</span>
                  <span className="flex-shrink-0 font-medium text-neutral-900 dark:text-white">{line.amount}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Secondary floating card — the same white-card convention
          (rounded-2xl border-neutral-200/70 bg-white shadow) used
          everywhere in the real app, kept small so it reads as a
          companion detail rather than a second competing screen. */}
      <div className="absolute -bottom-6 -right-4 hidden w-44 rounded-2xl border border-neutral-200/70 bg-white p-3.5 shadow-lg shadow-neutral-900/10 dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-black/30 sm:block">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-neutral-500">
          <Receipt className="h-3.5 w-3.5" aria-hidden="true" /> Today
        </div>
        <p className="mt-1 text-lg font-semibold text-neutral-900 dark:text-white">38 sales</p>
        <p className="mt-0.5 text-[11px] text-neutral-500">GH₵ 2,340 taken</p>
      </div>
    </div>
  );
}