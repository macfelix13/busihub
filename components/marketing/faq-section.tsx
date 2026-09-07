import { ChevronDown } from "lucide-react";
import { SectionHeading } from "./section-heading";

/**
 * Native <details>/<summary> rather than a hand-rolled accordion — free,
 * correct keyboard and screen-reader behaviour (Enter/Space toggles,
 * state is announced) with no JavaScript needed. Answers are grounded in
 * what's actually implemented (see the codebase audit in this build's
 * commit message / PR description) — in particular "Can I import
 * existing products?" is answered honestly as not yet self-serve, since
 * there's no bulk-import feature in the app today.
 */
const FAQS: { question: string; answer: string }[] = [
  {
    question: "What is Busihub?",
    answer:
      "Busihub is a point-of-sale and business management platform that helps you sell, manage stock, accept payments, and understand your business from one place.",
  },
  {
    question: "Who is Busihub for?",
    answer:
      "Retail shops, boutiques, supermarkets, salons, barbershops, restaurants, pharmacies, and other small and medium-sized product or service businesses.",
  },
  {
    question: "Can I use Busihub for a salon or barbershop?",
    answer:
      "Yes. Busihub supports a service catalogue with your own pricing, so you don't have to manage stock you don't have.",
  },
  {
    question: "Can I use Busihub for a retail shop?",
    answer: "Yes. Full inventory tracking, product variants, barcode scanning, and stock alerts are built in.",
  },
  {
    question: "Can I scan products with my phone?",
    answer: "Yes, using a compatible phone's camera — no separate scanner required.",
  },
  {
    question: "Can I use a barcode scanner?",
    answer: "Yes, a supported USB or Bluetooth barcode scanner works at the till.",
  },
  {
    question: "Can I connect my Paystack account?",
    answer: "Yes. You connect your own Paystack account to accept card and mobile money payments.",
  },
  {
    question: "Does Busihub hold my customer payments?",
    answer:
      "No. Busihub is designed so businesses connect their own Paystack account. Customer payments are processed through that connected account, not collected into a central Busihub payment account.",
  },
  {
    question: "Can my cashiers use Busihub?",
    answer: "Yes. You can create cashier accounts and control exactly what each person can do with role-based permissions.",
  },
  {
    question: "Can I manage inventory?",
    answer: "Yes — products, categories, variants, stock levels, receiving, adjustments, counts, and low-stock alerts.",
  },
  {
    question: "Can I print receipts?",
    answer: "Yes, receipts can be printed and also shared digitally, for example over WhatsApp.",
  },
  {
    question: "Can I access Busihub on my phone?",
    answer: "Yes, Busihub is a responsive web app that works on supported phones, tablets, laptops and desktops.",
  },
  {
    question: "Can I import existing products?",
    answer:
      "There's no self-serve bulk import yet — you add products individually today, with more setup options on the way.",
  },
  {
    question: "Is Busihub suitable for multiple branches?",
    answer: "Yes, Busihub supports managing more than one branch under the same business.",
  },
  {
    question: "Is Busihub available in Ghana?",
    answer: "Yes — Busihub is built for businesses in Ghana, including local mobile money networks.",
  },
];

export function FaqSection() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-5 py-16 sm:px-6 sm:py-24">
      <SectionHeading eyebrow="FAQ" title="Frequently asked questions" />
      <div className="mt-10 flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
        {FAQS.map((faq) => (
          <details key={faq.question} className="group py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left text-sm font-semibold text-neutral-900 marker:content-none dark:text-white">
              {faq.question}
              <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400 transition-transform duration-200 group-open:rotate-180" />
            </summary>
            <p className="mt-2.5 text-sm text-neutral-600 dark:text-neutral-400">{faq.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}