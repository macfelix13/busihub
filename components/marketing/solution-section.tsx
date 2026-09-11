import { ShoppingCart, Boxes, Wallet, Users, BarChart3, ArrowDown } from "lucide-react";
import { SectionHeading } from "./section-heading";

const FLOW = [
  { icon: ShoppingCart, label: "Sales" },
  { icon: Boxes, label: "Inventory" },
  { icon: Wallet, label: "Payments" },
  { icon: Users, label: "Customers" },
  { icon: BarChart3, label: "Reports" },
];

export function SolutionSection() {
  return (
    <section className="border-t border-neutral-200 bg-canvas dark:border-surface-line dark:bg-surface/40">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center lg:gap-16">
          <SectionHeading
            align="left"
            eyebrow="Solutions"
            title="Everything you need to run your business, in one place."
            description="Busihub connects the everyday operations of a business into one platform. A sale updates your stock, a payment settles against that sale, and every one of them shows up in your reports — instead of living in separate notebooks, apps, or spreadsheets."
          />

          <div className="flex flex-col items-center gap-1">
            {FLOW.map((step, i) => (
              <div key={step.label} className="flex flex-col items-center gap-1">
                <div className="flex w-56 items-center gap-3 rounded-2xl border border-neutral-200 bg-white px-4 py-3 shadow-sm dark:border-surface-line dark:bg-surface-card">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                    <step.icon className="h-5 w-5" />
                  </div>
                  <span className="text-sm font-semibold text-neutral-900 dark:text-ink">{step.label}</span>
                </div>
                {i < FLOW.length - 1 ? <ArrowDown className="h-4 w-4 text-neutral-300 dark:text-ink-muted" /> : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}