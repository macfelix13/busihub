import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { supportEmail } from "@/lib/env";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms for using Busihub.",
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
 * Busihub's real Terms of Service, not a placeholder — drafted 2026-09-11
 * as the counterpart to app/privacy/page.tsx, grounded in what the product
 * actually offers today (verified in the codebase): a 14-day free trial
 * with no card required and no published paid plans yet (see
 * components/marketing/pricing-preview.tsx's own comment on why no
 * tiers/prices are invented here), and payments that move through each
 * business's own connected Paystack account rather than through Busihub
 * (docs/SECURITY.md — Busihub never holds a platform-level Paystack key
 * or custody of business/customer money).
 *
 * IMPORTANT — not a substitute for legal review: same caveat as the
 * privacy policy. Written by an AI assistant from the codebase's real
 * behavior and the business decisions the operator gave directly
 * (sole-trader operation as "Busihub", Ghana governing law, an interim
 * contact email). Has not been reviewed by a lawyer — confirm this
 * document (and, in particular, the limitation-of-liability and
 * governing-law sections, which carry the most legal weight) before
 * relying on it, especially before onboarding real paying businesses.
 *
 * Contact email is read from lib/env.ts's supportEmail(), same as the
 * privacy policy, so both pages stay in sync when a dedicated mailbox
 * replaces the current fallback.
 */
export default function TermsPage() {
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
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-ink">Terms of Service</h1>
        <p className="text-sm text-neutral-500 dark:text-ink-muted">Last updated {LAST_UPDATED}</p>
      </div>

      <section className="flex flex-col gap-2">
        <H2>Acceptance of these terms</H2>
        <P>
          These terms are an agreement between you and Busihub (&ldquo;Busihub&rdquo;, &ldquo;we&rdquo;,
          &ldquo;us&rdquo;) for use of the Busihub point-of-sale and business management software (the
          &ldquo;Service&rdquo;). By creating an account or using the Service, you agree to these terms. If you are
          creating an account on behalf of a business, you&apos;re confirming you have the authority to accept these
          terms for that business, and &ldquo;you&rdquo; below refers to that business and its authorized users.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>What Busihub is</H2>
        <P>
          Busihub is software that helps a business run its point of sale, inventory, staff, and related operations.
          Busihub provides the software; it does not run your business for you, does not take title to your
          inventory, and — except where these terms say otherwise — is not a party to the sales your business makes
          to its own customers.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Accounts, access and your responsibilities</H2>
        <Ul>
          <li>You&apos;re responsible for the accuracy of the information you enter into Busihub, and for keeping
            your account credentials — and any till PIN you set for staff — confidential.</li>
          <li>You&apos;re responsible for the staff accounts you create and the permissions you grant them; Busihub
            enforces the permissions you set, but doesn&apos;t decide who on your team should have them.</li>
          <li>Notify us if you become aware of unauthorized access to your account.</li>
          <li>You must be lawfully permitted to operate the business you register, and to process the customer data
            you choose to store in Busihub.</li>
        </Ul>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Free trial and pricing</H2>
        <P>
          New accounts start with a 14-day free trial with full access and no card required, as described at
          signup. Busihub does not currently publish paid plans or pricing — we&apos;ll communicate directly with you
          before any change that would require payment to keep using the Service, and you&apos;ll have the choice to
          accept it or stop using Busihub.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Payments through Paystack</H2>
        <P>
          If you accept payments through Busihub, they are processed by Paystack through your own connected Paystack
          account, under Paystack&apos;s own terms and pricing for that processing. Busihub is not a party to those
          transactions, does not hold your funds at any point, and is not responsible for Paystack&apos;s processing,
          settlement, or availability. Disputes about a specific payment or payout are between you, your customer,
          and Paystack.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Acceptable use</H2>
        <P>You agree not to:</P>
        <Ul>
          <li>Use Busihub for any unlawful purpose, or to process data you&apos;re not entitled to process.</li>
          <li>Attempt to bypass, disable, or interfere with Busihub&apos;s security, tenant isolation, or rate
            limiting.</li>
          <li>Access or attempt to access another business&apos;s data on Busihub.</li>
          <li>Reverse-engineer, resell, or use the Service to build a competing product.</li>
          <li>Introduce malware, or attempt to overload or disrupt the Service.</li>
        </Ul>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Your content and data</H2>
        <P>
          You retain ownership of the business and customer data you put into Busihub. You grant us the right to
          host, process, and display it back to you as needed to provide the Service. We handle it as described in
          our{" "}
          <Link href="/privacy" className="font-medium text-brand-700 hover:underline dark:text-brand-300">
            Privacy Policy
          </Link>
          . If you stop using Busihub, our data retention and deletion practices are described there too.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Availability and changes to the service</H2>
        <P>
          We aim to keep Busihub available and reliable, but we don&apos;t guarantee uninterrupted access — the
          Service may be unavailable at times for maintenance, updates, or reasons outside our control. We may add,
          change, or remove features as Busihub develops; if we discontinue the Service entirely, we&apos;ll make a
          reasonable effort to give account holders advance notice.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Disclaimer of warranties</H2>
        <P>
          Busihub is provided &ldquo;as is&rdquo;, without warranties of any kind, express or implied, including
          warranties of merchantability, fitness for a particular purpose, or non-infringement. We don&apos;t
          warrant that the Service will be error-free or uninterrupted, or that it is suitable for every business&apos;s
          particular needs.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Limitation of liability</H2>
        <P>
          To the fullest extent permitted by law, Busihub will not be liable for indirect, incidental, special, or
          consequential damages, or for lost profits, lost sales, or lost data, arising from your use of the
          Service. This does not limit liability where the law does not allow it to be limited.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Suspension and termination</H2>
        <P>
          You may stop using Busihub at any time. We may suspend or terminate an account that violates these terms,
          poses a security risk to Busihub or other businesses on it, or where required by law. Where practical,
          we&apos;ll give notice first and a chance to fix the issue, except where the risk requires acting
          immediately.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Changes to these terms</H2>
        <P>
          We may update these terms as Busihub changes. We&apos;ll update the &ldquo;Last updated&rdquo; date above
          when we do, and for a significant change, we&apos;ll make a reasonable effort to let account holders know
          directly. Continuing to use Busihub after a change takes effect means you accept the updated terms.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Governing law</H2>
        <P>
          These terms are governed by the laws of Ghana, without regard to conflict-of-law principles. Any dispute
          arising from these terms or your use of Busihub will be subject to the exclusive jurisdiction of the
          courts of Ghana.
        </P>
      </section>

      <section className="flex flex-col gap-2">
        <H2>Contact us</H2>
        <P>
          Questions about these terms? Email us at{" "}
          <a href={`mailto:${email}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
            {email}
          </a>
          .
        </P>
      </section>
    </main>
  );
}