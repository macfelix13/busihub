import { Lock, ShieldCheck, KeyRound, ScrollText, UserCheck } from "lucide-react";
import { SectionHeading } from "./section-heading";

/**
 * Every item here is a real, specific mechanism in the codebase — not a
 * generic "bank-level security" claim. Deliberately no PCI DSS / ISO /
 * "bank-level encryption" wording: none of those are certifications this
 * product actually holds.
 */
const MEASURES = [
  {
    icon: ShieldCheck,
    title: "Tenant isolation",
    description: "One business can never see another business's products, sales, customers or reports — enforced at the database level, not just hidden in the interface.",
  },
  {
    icon: UserCheck,
    title: "Role-based access",
    description: "Every account has a role, and every sensitive action is checked against it on the server.",
  },
  {
    icon: KeyRound,
    title: "Encrypted payment credentials",
    description: "Your Paystack secret key is encrypted before it's stored and is never shown again, not even to you.",
  },
  {
    icon: Lock,
    title: "Server-verified payments",
    description: "A payment is only ever confirmed by Paystack itself — never by trusting what a browser reports back.",
  },
  {
    icon: ScrollText,
    title: "Audit trail",
    description: "Sensitive changes — like who changed a payment setting — are logged, not silent.",
  },
];

export function SecuritySection() {
  return (
    <section className="border-t border-neutral-200 bg-canvas dark:border-surface-line dark:bg-surface/40">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
        <SectionHeading
          eyebrow="Security"
          title="Your business data deserves serious protection."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {MEASURES.map((measure) => (
            <div key={measure.title} className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                <measure.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 text-sm font-semibold text-neutral-900 dark:text-ink">{measure.title}</h3>
              <p className="mt-1.5 text-sm text-neutral-500 dark:text-ink-muted">{measure.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}