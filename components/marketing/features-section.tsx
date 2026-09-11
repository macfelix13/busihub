import {
  ShoppingCart,
  Boxes,
  ScanLine,
  BarChart3,
  Users,
  Receipt,
  Check,
} from "lucide-react";
import { SectionHeading } from "./section-heading";

const FEATURES = [
  {
    icon: ShoppingCart,
    title: "Point of Sale",
    description: "Process sales quickly and efficiently, from checkout to receipt.",
    points: ["Fast checkout", "Product search", "Barcode scanning", "Discounts with a cap you control", "Multiple payment methods", "Cashier accounts"],
  },
  {
    icon: Boxes,
    title: "Inventory management",
    description: "Keep control of stock across every branch.",
    points: ["Product & category management", "Product variants", "Stock receiving, adjustments & counts", "Low-stock alerts", "Multi-branch stock"],
  },
  {
    icon: ScanLine,
    title: "Barcode scanning",
    description: "Find and add products in a scan.",
    points: ["Works with USB/Bluetooth barcode scanners", "Or scan with a phone camera", "Straight into the cart"],
  },
  {
    icon: BarChart3,
    title: "Sales & reports",
    description: "See how the business is actually doing.",
    points: ["Daily, weekly & monthly sales", "Profit & loss", "Best-selling products", "Sales by cashier & branch", "Payment method breakdown", "CSV export"],
  },
  {
    icon: Users,
    title: "Customers",
    description: "Know who you're selling to.",
    points: ["Customer profiles & purchase history", "Optional details at checkout", "Customer accounts with a credit limit"],
  },
  {
    icon: Receipt,
    title: "Receipts",
    description: "Professional receipts, printed or shared.",
    points: ["Thermal & A4 receipt printing", "Shareable receipt text for WhatsApp", "Business details on every receipt"],
  },
];

export function FeaturesSection() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
      <SectionHeading
        eyebrow="Features"
        title="Everything you need to run the counter and the back office."
        description="Built for the day-to-day of running a shop or service business — not a generic template of features you'll never use."
      />
      <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature) => (
          <div
            key={feature.title}
            className="flex flex-col rounded-2xl border border-neutral-200 bg-white p-6 transition-shadow hover:shadow-md hover:shadow-neutral-900/5 dark:border-surface-line dark:bg-surface-card dark:hover:shadow-black/30"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
              <feature.icon className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-neutral-900 dark:text-ink">{feature.title}</h3>
            <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">{feature.description}</p>
            <ul className="mt-4 flex flex-col gap-2">
              {feature.points.map((point) => (
                <li key={point} className="flex items-start gap-2 text-sm text-neutral-600 dark:text-ink-muted">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                  {point}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}