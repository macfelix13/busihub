"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Print, and copy-for-sharing.
 *
 * There is deliberately no "send to the customer" button here. Sending
 * would mean a receipt anyone with the link can open, which is a public
 * unauthenticated page showing what someone bought and what they paid —
 * a real decision with a real privacy cost, not a convenience to add in
 * passing. Until that is designed, the cashier copies the text and sends
 * it through whatever they already use, which in practice is WhatsApp.
 */
export function ReceiptControls({ text }: { text: string }) {
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
        <Button type="button" onClick={() => window.print()}>
          Print
        </Button>
        <Button type="button" variant="secondary" onClick={copy}>
          {copied ? "Copied" : "Copy for WhatsApp"}
        </Button>
      </div>
      {copyFailed ? (
        <p className="text-sm text-neutral-500 dark:text-ink-muted">
          Your browser wouldn&apos;t let the page copy. Select the receipt below and copy it yourself.
        </p>
      ) : null}
    </div>
  );
}