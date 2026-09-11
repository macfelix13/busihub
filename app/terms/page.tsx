import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms for using Busihub.",
};

export default function TermsPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-5 py-16 sm:px-6">
      <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-800 dark:text-ink-muted dark:hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> Back to Busihub
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-ink">Terms of Service</h1>
      <p className="text-sm text-neutral-600 dark:text-ink-muted">
        This page is a placeholder. Busihub&apos;s full Terms of Service — covering your account, acceptable use, and
        how the free trial and any paid plans work — are being finalized.
      </p>
      <p className="text-sm text-neutral-600 dark:text-ink-muted">
        One thing worth stating plainly now: any payments your business takes through Busihub move through your own
        connected Paystack account, under Paystack&apos;s own terms — Busihub is not a party to that transaction.
      </p>
    </main>
  );
}