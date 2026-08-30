"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatusToggleButton } from "../products/status-toggle-button";
import { checkSalePayment, cancelSale } from "./actions";

/**
 * The window between the customer approving a prompt on their phone and
 * us finding out. Paystack gives them 180 seconds.
 *
 * The webhook is what normally settles this, and it lands within a second
 * or two — but a webhook can be slow, blocked, or misconfigured, and a
 * cashier cannot stand there wondering. So the page also asks Paystack
 * directly on a timer. Both routes settle through the same database
 * function, so whichever arrives first wins and the other finds the work
 * already done.
 */

interface AwaitingPaymentProps {
  saleId: string;
  momoNumber: string | null;
  networkLabel: string;
  amount: string;
  canCancel: boolean;
}

const POLL_MS = 4000;
/** Paystack's own limit, plus a little slack for the last webhook to arrive. */
const GIVE_UP_AFTER_MS = 200_000;

export function AwaitingPayment({ saleId, momoNumber, networkLabel, amount, canCancel }: AwaitingPaymentProps) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const checking = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Read inside the effect, not during render: a component may render
    // more than once, and a clock read while rendering would give a
    // different answer each time. (React's purity rule catches this.)
    const startedAt = Date.now();

    const tick = window.setInterval(() => {
      if (cancelled) return;
      setElapsed(Date.now() - startedAt);
    }, 1000);

    const poll = window.setInterval(async () => {
      if (cancelled || checking.current) return;
      if (Date.now() - startedAt > GIVE_UP_AFTER_MS) return;

      // A slow round trip must not stack up behind itself — otherwise a
      // few seconds of latency turns into a queue of duplicate checks.
      checking.current = true;
      try {
        const result = await checkSalePayment(saleId);
        if (cancelled) return;
        if (result.error) setNote(result.error);
        if (result.status === "completed") {
          // The server has already revalidated; this re-renders the page
          // as a finished receipt.
          router.refresh();
        }
      } catch {
        // A dropped request is not news — the next tick tries again.
      } finally {
        checking.current = false;
      }
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [saleId, router]);

  const seconds = Math.floor(elapsed / 1000);
  const expired = elapsed > GIVE_UP_AFTER_MS;

  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-900 dark:bg-amber-950/40">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`h-2.5 w-2.5 rounded-full ${expired ? "bg-neutral-400" : "animate-pulse bg-amber-500"}`}
          aria-hidden="true"
        />
        <h2 className="font-semibold text-amber-900 dark:text-amber-200">
          {expired ? "No answer from the customer" : "Waiting for the customer to approve"}
        </h2>
      </div>

      <p className="mt-2 text-sm text-amber-900/90 dark:text-amber-200/90">
        {expired ? (
          <>
            The prompt to {momoNumber ?? "their phone"} has expired. Nothing has been charged. Cancel this sale to put
            the items back on the shelf, then try again.
          </>
        ) : (
          <>
            {amount} was sent to {momoNumber ?? "their phone"} on {networkLabel}. They have about three minutes to
            approve it on their own handset.
          </>
        )}
      </p>

      {!expired ? (
        <p className="mt-1 text-sm text-amber-900/70 dark:text-amber-200/70" aria-live="polite">
          Checking… {seconds}s
        </p>
      ) : null}

      {note ? <p className="mt-2 text-sm text-red-700 dark:text-red-300">{note}</p> : null}

      <p className="mt-3 text-sm text-amber-900/70 dark:text-amber-200/70">
        The goods have already come off the shelf, so this sale is holding stock until it is paid or cancelled.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => router.refresh()}>
          Check now
        </Button>
        {canCancel ? (
          <StatusToggleButton
            action={cancelSale.bind(null, saleId)}
            label="Cancel sale"
            pendingLabel="Cancelling…"
            variant="danger"
          />
        ) : null}
      </div>
    </div>
  );
}
