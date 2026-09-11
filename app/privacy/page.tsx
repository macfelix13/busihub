import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { supportEmail } from "@/lib/env";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Busihub handles business and customer data.",
};

const LAST_UPDATED = "11 September 2026";

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold text-neutral-900 dark:text-ink">{children}</h2>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-neutral-600 dark:text-ink-muted">{children}</p>;
}

function Ul({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5 text-sm text-neutral-600 dark:text-ink-muted">{children}</ul>;
}

/**
 * Busihub's real Privacy Policy, not a placeholder — drafted 2026-09-11
 * against what the product actually does (verified in the codebase: no
 * analytics/advertising scripts anywhere, Paystack secret keys are
 * AES-256-GCM encrypted at rest per lib/crypto/secret-box.ts, Busihub
 * never holds a business's or its customers' money, tenant data is
 * isolated by Postgres RLS — see docs/SECURITY.md).
 *
 * IMPORTANT — not a substitute for legal review: this was written by an
 * AI assistant from the codebase's real, verified behavior and the
 * business decisions the operator gave directly (sole-trader operation,
 * Ghana governing law, an interim contact email). It has not been
 * reviewed by a lawyer. In particular, if Busihub processes personal
 * data of people in Ghana, registering as a data controller with Ghana's
 * Data Protection Commission under the Data Protection Act, 2012 (Act
 * 843) may be a legal requirement — confirm this (and the rest of this
 * document) with a lawyer before relying on it, especially before
 * onboarding real paying businesses.
 *
 * Contact email is read from lib/env.ts's supportEmail() rather than
 * hardcoded here — see that function's own comment. Update the
 * NEXT_PUBLIC_SUPPORT_EMAIL env var (or its fallback) once a dedicated
 * mailbox exists and every page that shows a contact address, this one
 * included, updates together.
 */
export default function PrivacyPage() {
  const email = supportEmail();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-5 py-16 sm:px-6">
      <div className="flex flex-col gap-3">
        <Link
          href="/"
          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-800 dark:text-ink-muted dark:hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Busihub
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-ink">Privacy Policy</h1>
        <p className="text-sm text-neutral-500 dark:text-ink-muted">Last updated {LAST_UPDATED}</p>
      </div>

      <section className="flex flex-col gap-2">
        <P>
          Busihub (&ldquo;Busihub&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) provides point-of-sale and business
          management software. This policy explains what information we collect through Busihub, how it&apos;s used,
          who it&apos;s shared with, and how it&apos;s protected — for both the businesses that use Busihub and the
          staff and customers whose information those businesses store in it.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Information we collect</H2>
        <P>
          <strong className="font-medium text-neutral-800 dark:text-ink">Account information.</strong> When a
          business registers, we collect the business name, the owner&apos;s name, email address, and optional phone
          number. When an owner or manager adds staff, we collect each staff member&apos;s name and, for those who
          sign in, an email address. Every account password is stored by our authentication provider (Supabase Auth)
          using industry-standard hashing — Busihub never sees or stores a plain-text password. A cashier&apos;s
          till PIN is stored only as a one-way hash, the same way.
        </P>
        <P>
          <strong className="font-medium text-neutral-800 dark:text-ink">
            Business data you store in Busihub.
          </strong>{" "}
          Products, categories, stock levels, sales, purchase orders, suppliers, expenses, and branches — everything
          a business enters to run its operations. This is the business&apos;s own data; we process it on the
          business&apos;s behalf to provide the service.
        </P>
        <P>
          <strong className="font-medium text-neutral-800 dark:text-ink">Customer data entered by a business.</strong>{" "}
          A business may store its own customers&apos; names, phone numbers, and purchase or credit history in
          Busihub. If you are a customer of a business that uses Busihub, that business — not Busihub — controls
          what&apos;s stored about you and is who you should contact with questions about it; Busihub processes it
          only on that business&apos;s instructions.
        </P>
        <P>
          <strong className="font-medium text-neutral-800 dark:text-ink">Payment information.</strong> Busihub does
          not collect or store card numbers or mobile money numbers for the payments a business&apos;s customers
          make. Those payments are processed directly by Paystack through each business&apos;s own connected
          Paystack account. The one payment-related secret Busihub does store is that business&apos;s own Paystack
          secret API key, and it is encrypted (AES-256-GCM) before it&apos;s ever written to our database — even we
          cannot read it back in plain text; the business only ever sees the last four characters, to confirm which
          key is installed.
        </P>
        <P>
          <strong className="font-medium text-neutral-800 dark:text-ink">Device and session information.</strong> We
          use a session cookie to keep you signed in, and a separate cookie for a shared till device to remember
          which cashier unlocked it. Your light/dark theme preference is stored only in your own browser
          (localStorage), never sent to us. We do not currently use analytics, advertising, or tracking cookies of
          any kind.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>How we use information</H2>
        <Ul>
          <li>To operate Busihub — process sales, track inventory, generate reports, and everything else the
            product does.</li>
          <li>To authenticate accounts and keep them secure, including rate-limiting repeated failed sign-in
            attempts.</li>
          <li>To provide support when a business or its staff contacts us.</li>
          <li>To maintain the audit trail Busihub keeps of sensitive changes (like who changed a payment setting),
            for the business&apos;s own accountability.</li>
          <li>To meet legal obligations, where applicable.</li>
        </Ul>
        <P>We do not sell personal information, and we do not use it for advertising.</P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Who we share information with</H2>
        <P>Busihub runs on a small number of infrastructure providers, each with a specific, limited role:</P>
        <Ul>
          <li>
            <strong className="font-medium text-neutral-800 dark:text-ink">Supabase</strong> — hosts our database
            and handles authentication (sign-in, password storage).
          </li>
          <li>
            <strong className="font-medium text-neutral-800 dark:text-ink">Vercel</strong> — hosts the Busihub
            application itself.
          </li>
          <li>
            <strong className="font-medium text-neutral-800 dark:text-ink">Paystack</strong> — processes payments,
            through each business&apos;s own connected Paystack account, under Paystack&apos;s own privacy practices
            for that processing.
          </li>
        </Ul>
        <P>
          We don&apos;t share information with anyone else except where required by law, or with a business&apos;s
          explicit consent.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>How we protect information</H2>
        <Ul>
          <li>Every business&apos;s data is isolated at the database level (Postgres row-level security) — one
            business cannot query or see another&apos;s data, enforced by the database itself, not just hidden in
            the interface.</li>
          <li>Every sensitive server action re-checks the caller&apos;s permission itself, not just the interface.</li>
          <li>Payment credentials are encrypted at rest, as described above.</li>
          <li>Repeated failed sign-in or PIN attempts are rate-limited and temporarily locked out.</li>
        </Ul>
        <P>
          No system is perfectly secure, and we can&apos;t guarantee absolute security — but we design for it
          deliberately rather than as an afterthought, and our security practices are documented in full at{" "}
          <span className="font-mono text-xs">docs/SECURITY.md</span> in our source repository.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Data retention</H2>
        <P>
          We keep a business&apos;s data for as long as its account is active. If a business closes its account, we
          retain its data for a limited period afterward in case it needs to be recovered, and for our own legal and
          backup purposes, before it is deleted. If you&apos;d like your business&apos;s data deleted sooner, or have
          questions about what&apos;s retained, contact us using the details below.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Your rights and choices</H2>
        <P>
          Busihub doesn&apos;t yet have a self-serve way to export or delete your data from within the product — that
          is on our roadmap, not something we&apos;re pretending already exists. Until then, contact us at the email
          below and we will handle the request directly. If you are a customer of a business that uses Busihub
          (rather than a Busihub account holder yourself), please contact that business directly first, since they
          control what&apos;s stored about you.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Children&apos;s privacy</H2>
        <P>
          Busihub is a business tool and is not directed at, or knowingly used to collect information from, children.
          If you believe a child has provided us with personal information, contact us and we will remove it.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>International data</H2>
        <P>
          Our infrastructure providers (Supabase, Vercel) may process and store data in countries other than your
          own. By using Busihub, you understand your information may be handled in those locations.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Changes to this policy</H2>
        <P>
          We may update this policy as Busihub changes. We&apos;ll update the &ldquo;Last updated&rdquo; date above
          when we do, and for a significant change, we&apos;ll make a reasonable effort to let account holders know
          directly.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Contact us</H2>
        <P>
          Questions about this policy, or a request about your data? Email us at{" "}
          <a href={`mailto:${email}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
            {email}
          </a>
          .
        </P>
      </section>
    </main>
  );
}