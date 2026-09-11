import Link from "next/link";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "./section-heading";

/**
 * No plan names, tiers or prices are shown — the subscription schema
 * exists in the database but there is no public pricing or plan-selection
 * UI in the product yet, so inventing "Starter/Business/Enterprise" price
 * points here would be exactly the fake-completion the spec warns
 * against. What IS real and shown here verbatim is the actual signup
 * offer from app/(auth)/register/page.tsx: a 14-day free trial, no card
 * required.
 */
export function PricingPreview() {
  return (
    <section id="pricing" className="border-t border-neutral-200 bg-canvas dark:border-surface-line dark:bg-surface/40">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
        <SectionHeading
          eyebrow="Pricing"
          title="Simple plans for growing businesses."
          description="Full pricing details are on the way. Start today and decide on a plan later."
        />

        <div className="mx-auto mt-10 max-w-md rounded-2xl border border-neutral-200 bg-white p-8 text-center dark:border-surface-line dark:bg-surface-card">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-950 dark:text-brand-400">
            Free trial
          </p>
          <p className="mt-2 text-3xl font-semibold text-neutral-900 dark:text-ink">14 days</p>
          <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">No card required</p>
          <ul className="mt-6 flex flex-col gap-2.5 text-left">
            {["Full access while you try it out", "Set up your products or services", "Connect your own Paystack account when you're ready"].map(
              (item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-neutral-700 dark:text-ink-muted">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                  {item}
                </li>
              )
            )}
          </ul>
          <Link href="/register" className="mt-6 block">
            <Button className="w-full">Get started</Button>
          </Link>
        </div>
      </div>
    </section>
  );
}