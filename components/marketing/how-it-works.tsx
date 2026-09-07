import { SectionHeading } from "./section-heading";

const STEPS = [
  { number: "01", title: "Create your account", description: "Set up your business in minutes." },
  { number: "02", title: "Add your products or services", description: "Build your catalogue, whichever kind of business you run." },
  { number: "03", title: "Connect your payments", description: "Connect your own Paystack account if you want mobile money or card payments." },
  { number: "04", title: "Start selling", description: "Open your till and start serving customers." },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
      <SectionHeading eyebrow="How it works" title="From sign-up to your first sale." />
      <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step) => (
          <div key={step.number} className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-brand-600 dark:text-brand-400">{step.number}</span>
            <h3 className="text-base font-semibold text-neutral-900 dark:text-white">{step.title}</h3>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{step.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}