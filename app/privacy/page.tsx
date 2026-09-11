import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Busihub handles business and customer data.",
};

/**
 * A short, honest holding page rather than a fabricated legal document.
 * The master spec is explicit: no fake legal claims. A finished privacy
 * policy needs sign-off from whoever actually owns Busihub's data
 * practices, so this states plainly that it's in progress instead of
 * inventing specifics that would look official but aren't accurate.
 */
export default function PrivacyPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-5 py-16 sm:px-6">
      <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-800 dark:text-ink-muted dark:hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> Back to Busihub
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-ink">Privacy Policy</h1>
      <p className="text-sm text-neutral-600 dark:text-ink-muted">
        This page is a placeholder. Busihub&apos;s full Privacy Policy is being finalized and will explain, in plain
        language, what information is collected from businesses and their customers, how it is used, and how it is
        protected.
      </p>
      <p className="text-sm text-neutral-600 dark:text-ink-muted">
        In the meantime, what&apos;s already true in the product: Busihub does not hold your customer payment funds —
        payments are processed through your own connected Paystack account — and sensitive credentials, like your
        Paystack secret key, are encrypted before they&apos;re stored.
      </p>
    </main>
  );
}