"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Print, copy for WhatsApp, download as CSV.
 *
 * The CSV is a plain link rather than a fetch: a link is what a browser
 * already knows how to save, it works when JavaScript is still loading,
 * and it survives being long-pressed on a phone. The route behind it
 * re-checks the permission and re-runs the same database function, so
 * the URL is not a way around anything — the figures in the file are the
 * figures the caller could already see.
 */

interface ReportControlsProps {
  /** The plain-text version, for the clipboard. */
  text: string;
  /** Where the CSV lives, or omitted when the person may not export. */
  csvHref?: string;
}

export function ReportControls({ text, csvHref }: ReportControlsProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy() {
    setCopyFailed(false);
    try {
      // Only available over HTTPS (or localhost) and only after a real
      // click. Both hold here, but a browser can still refuse.
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-2 print:hidden">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => window.print()}>
          Print
        </Button>
        <Button type="button" variant="secondary" onClick={copy}>
          {copied ? "Copied" : "Copy for WhatsApp"}
        </Button>
        {csvHref ? (
          <a
            href={csvHref}
            className="inline-flex min-h-[44px] items-center rounded-xl border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white"
          >
            Download CSV
          </a>
        ) : null}
      </div>
      {copyFailed ? (
        <p className="text-sm text-neutral-500">
          Your browser wouldn&apos;t let the page copy. Select the report below and copy it yourself.
        </p>
      ) : null}
    </div>
  );
}