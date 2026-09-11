import { NotebookPen, PackageSearch, Banknote, BarChart3, Timer, Unplug } from "lucide-react";
import { SectionHeading } from "./section-heading";

const PROBLEMS = [
  {
    icon: NotebookPen,
    title: "Manual sales tracking",
    description: "Stop relying on notebooks and scattered records to know what you sold.",
  },
  {
    icon: PackageSearch,
    title: "Stock guesswork",
    description: "Know what you actually have on the shelf before you sell it, not after.",
  },
  {
    icon: Banknote,
    title: "Payment confusion",
    description: "Keep payment records connected to the sale they belong to.",
  },
  {
    icon: BarChart3,
    title: "No clear reports",
    description: "Understand your daily, weekly, and monthly performance at a glance.",
  },
  {
    icon: Timer,
    title: "Slow checkout",
    description: "Give customers a faster, more confident checkout experience.",
  },
  {
    icon: Unplug,
    title: "Disconnected operations",
    description: "Bring sales, inventory, payments, customers and reporting together.",
  },
];

export function ProblemSection() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
      <SectionHeading title="Running a business shouldn't mean juggling everything manually." />
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PROBLEMS.map((problem) => (
          <div
            key={problem.title}
            className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-neutral-100 text-neutral-600 dark:bg-surface dark:text-ink-muted">
              <problem.icon className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-neutral-900 dark:text-ink">{problem.title}</h3>
            <p className="mt-1.5 text-sm text-neutral-500 dark:text-ink-muted">{problem.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}