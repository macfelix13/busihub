import { Wallet, TrendingUp, PiggyBank, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SectionHeading } from "./section-heading";

const KPIS = [
  { icon: Wallet, label: "Today's sales", value: "GH₵ 2,340", accent: "text-neutral-900 dark:text-white" },
  { icon: TrendingUp, label: "Transactions", value: "38", accent: "text-neutral-900 dark:text-white" },
  { icon: PiggyBank, label: "Gross profit", value: "GH₵ 890", accent: "text-neutral-900 dark:text-white" },
  { icon: AlertTriangle, label: "Low stock", value: "5 items", accent: "text-amber-600 dark:text-amber-400" },
];

const TOP_PRODUCTS = [
  { name: "Jollof rice (large)", amount: "GH₵ 540" },
  { name: "Bottled water 500ml", amount: "GH₵ 210" },
  { name: "Fried chicken (2 pcs)", amount: "GH₵ 480" },
];

/**
 * "Use realistic example data but clearly treat it as demonstration
 * data" — the section keeps a visible "Example data" label rather than
 * presenting these numbers as a real business's actual sales.
 */
export function DashboardSection() {
  return (
    <section className="border-t border-neutral-200 bg-canvas dark:border-neutral-800 dark:bg-neutral-900/40">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
        <SectionHeading
          eyebrow="Dashboard"
          title="See the whole business at a glance."
          description="Revenue, transactions, top products, and low-stock alerts — the numbers an owner actually checks every day."
        />

        <div className="mx-auto mt-10 max-w-4xl rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 sm:p-6">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-neutral-900 dark:text-white">Dashboard</span>
            <Badge variant="neutral">Example data</Badge>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {KPIS.map((kpi) => (
              <div key={kpi.label} className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
                <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  <kpi.icon className="h-3.5 w-3.5" /> {kpi.label}
                </div>
                <p className={`mt-1.5 text-xl font-semibold ${kpi.accent}`}>{kpi.value}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Best-selling products</p>
            <div className="mt-3 flex flex-col gap-2.5">
              {TOP_PRODUCTS.map((product) => (
                <div key={product.name} className="flex items-center justify-between text-sm">
                  <span className="text-neutral-700 dark:text-neutral-300">{product.name}</span>
                  <span className="font-medium text-neutral-900 dark:text-white">{product.amount}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}