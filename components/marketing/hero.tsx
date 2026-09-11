import Link from "next/link";
import { ArrowRight, Zap, Boxes, Wallet, LineChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeroMockup } from "./hero-mockup";

const VALUE_POINTS = [
  {
    icon: Zap,
    title: "Sell faster",
    description: "Process sales quickly from your phone, tablet, laptop, or desktop.",
  },
  {
    icon: Boxes,
    title: "Know your stock",
    description: "Track inventory and see what's selling and what needs restocking.",
  },
  {
    icon: Wallet,
    title: "Get paid",
    description: "Accept cash and mobile money through your own connected Paystack account.",
  },
  {
    icon: LineChart,
    title: "Understand your business",
    description: "See sales, products, customers and performance in one place.",
  },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto grid max-w-6xl gap-16 px-5 pb-16 pt-14 sm:px-6 sm:pt-20 lg:grid-cols-2 lg:items-center lg:gap-12 lg:pb-24 lg:pt-28">
        <div className="flex flex-col items-start gap-6">
          <span className="rounded-full bg-brand-50 px-3 py-1 text-sm font-medium text-brand-800 dark:bg-brand-950/40 dark:text-brand-300">
            Built for modern businesses in Ghana
          </span>
          <h1 className="text-balance text-4xl font-semibold tracking-tight text-neutral-900 dark:text-ink sm:text-5xl">
            Run your business. Sell smarter.
          </h1>
          <p className="max-w-xl text-pretty text-lg text-neutral-600 dark:text-ink-muted">
            Busihub is a simple, powerful POS and business management platform that helps you sell faster, manage
            inventory, accept payments, and keep track of your business — all in one place.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link href="/register">
              <Button className="w-full px-6 sm:w-auto">
                Get started <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <a href="#how-it-works">
              <Button variant="secondary" className="w-full px-6 sm:w-auto">
                See how it works
              </Button>
            </a>
          </div>

          <dl className="mt-4 grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
            {VALUE_POINTS.map((point) => (
              <div key={point.title} className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                  <point.icon className="h-5 w-5" />
                </div>
                <div>
                  <dt className="text-sm font-semibold text-neutral-900 dark:text-ink">{point.title}</dt>
                  <dd className="text-sm text-neutral-500 dark:text-ink-muted">{point.description}</dd>
                </div>
              </div>
            ))}
          </dl>
        </div>

        <div className="pb-10 pt-2 lg:pb-0 lg:pt-0">
          <HeroMockup />
        </div>
      </div>
    </section>
  );
}