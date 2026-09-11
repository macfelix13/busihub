import { User, Store, ArrowRight, ShieldCheck } from "lucide-react";
import { SectionHeading } from "./section-heading";

const FLOW = [
  { icon: User, label: "Customer" },
  { icon: Store, label: "Busihub POS" },
  { icon: ShieldCheck, label: "Paystack" },
  { icon: Store, label: "Your Paystack account" },
];

/**
 * The one claim on this whole page that matters most to get right:
 * Busihub never custodies a shop's money. lib/paystack/client.ts says it
 * directly — "Every business collects into its own Paystack account, so
 * there is no single API key here" — and every business connects its OWN
 * secret key, encrypted at rest, used only to call Paystack on that
 * business's behalf. This section exists to make that as plain to a
 * business owner as it already is in the code.
 */
export function PaymentsSection() {
  return (
    <section id="payments" className="border-t border-neutral-200 bg-canvas dark:border-surface-line dark:bg-surface/40">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
        <SectionHeading
          eyebrow="Payments"
          title="Accept payments your customers already use."
          description="Connect your own Paystack account to accept mobile money and card payments directly through Busihub."
        />

        <div className="mx-auto mt-10 flex max-w-3xl flex-wrap items-center justify-center gap-x-1 gap-y-6">
          {FLOW.map((step, i) => (
            <div key={`${step.label}-${i}`} className="flex items-center gap-1">
              <div className="flex w-24 flex-col items-center gap-2">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-neutral-200 bg-white text-brand-700 dark:border-surface-line dark:bg-surface-card dark:text-brand-300">
                  <step.icon className="h-5 w-5" />
                </div>
                <span className="text-center text-xs font-medium leading-tight text-neutral-600 dark:text-ink-muted">
                  {step.label}
                </span>
              </div>
              {i < FLOW.length - 1 ? (
                <ArrowRight className="h-4 w-4 shrink-0 text-neutral-300 dark:text-ink-muted" />
              ) : null}
            </div>
          ))}
        </div>

        <div className="mx-auto mt-10 max-w-2xl rounded-2xl border border-brand-200 bg-brand-50 p-5 text-center dark:border-brand-900 dark:bg-brand-950/30">
          <p className="text-sm font-medium text-brand-900 dark:text-brand-200">
            Your customers pay through your connected Paystack account. Busihub does not hold your customer payment
            funds.
          </p>
        </div>

        <p className="mx-auto mt-6 max-w-2xl text-center text-sm text-neutral-500 dark:text-ink-muted">
          Supports card payments and mobile money — MTN, Telecel and AirtelTigo — through your own Paystack
          integration.
        </p>
      </div>
    </section>
  );
}