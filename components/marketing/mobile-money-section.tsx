import { Smartphone, Fingerprint, CheckCircle2, ReceiptText } from "lucide-react";
import { SectionHeading } from "./section-heading";

/**
 * This mirrors the real settlement flow, not a simplified marketing
 * version of it: the cashier initiates a charge, the customer approves
 * on their own phone, and the sale only completes once Paystack's
 * webhook confirms success (app/api/webhooks/paystack/[businessId]/route.ts
 * calls settle_sale_payment — never on a client-reported status). "Waits
 * for confirmed payment before completing the sale" is a description of
 * what the code actually does, not an aspiration.
 */
const STEPS = [
  { icon: Smartphone, title: "Cashier enters the amount", description: "Right at the till, as part of checkout." },
  { icon: Fingerprint, title: "Customer approves on their phone", description: "The customer confirms the prompt on their own device." },
  { icon: CheckCircle2, title: "Paystack confirms payment", description: "Busihub waits for confirmation — it never trusts a status from the browser." },
  { icon: ReceiptText, title: "Busihub completes the sale", description: "The receipt and records update automatically." },
];

export function MobileMoneySection() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
      <SectionHeading
        eyebrow="Mobile money"
        title="Mobile money at the till."
        description="Let your cashier initiate a mobile money payment from the till while the customer approves it on their own phone."
      />

      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step, i) => (
          <div key={step.title} className="relative rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
            <span className="absolute -top-3 left-5 flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
              {i + 1}
            </span>
            <div className="mt-2 flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
              <step.icon className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-sm font-semibold text-neutral-900 dark:text-white">{step.title}</h3>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{step.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}