"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatusToggleButton } from "../products/status-toggle-button";
import { checkSalePayment, cancelSale, submitMomoOtp } from "./actions";

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
  /**
   * True when Paystack answered the initial charge with "send_otp" — it
   * texted the customer a code instead of (or before) a direct approval
   * prompt, and nothing settles until that code is submitted back. The
   * plain "waiting for approval" polling loop never resolves this on its
   * own, so this switches the panel to an entry form for the code.
   */
  awaitingOtp: boolean;
  /**
   * Paystack's own wording for what to tell the customer/cashier about
   * THIS specific pending charge — set whenever we have it, whether or
   * not awaitingOtp is true. For MTN/AirtelTigo ("pay_offline") this is
   * informational only: the customer approves on their own phone and
   * there is nothing to type here. Falls back to a generic message when
   * Paystack didn't give us any wording to show.
   */
  otpPromptText: string | null;
}

const POLL_MS = 4000;
/** Paystack's own limit, plus a little slack for the last webhook to arrive. */
const GIVE_UP_AFTER_MS = 200_000;
/**
 * A genuine OTP charge needs more real time than a plain approval tap: the
 * SMS has to arrive, the customer has to read it out (often not the person
 * holding the phone at the till), and the cashier has to type it in and
 * submit it. Real report (2026-09): the entry form was disappearing well
 * before a cashier could realistically do all of that. This window only
 * controls how long the till keeps showing the entry form and polling for
 * a webhook that settled it in the background — it does not change what
 * Paystack itself allows on the customer's phone.
 */
const OTP_GIVE_UP_AFTER_MS = 300_000;

export function AwaitingPayment({
  saleId,
  momoNumber,
  networkLabel,
  amount,
  canCancel,
  awaitingOtp,
  otpPromptText,
}: AwaitingPaymentProps) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [declined, setDeclined] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [otpSubmitting, setOtpSubmitting] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const checking = useRef(false);

  async function handleSubmitOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (otpSubmitting) return;
    setOtpSubmitting(true);
    setOtpError(null);
    try {
      const result = await submitMomoOtp(saleId, otp);
      if (result.paymentStatus === "failed" || result.paymentStatus === "cancelled") {
        setDeclined(result.failureReason ?? "The customer did not approve it");
        return;
      }
      if (result.status === "completed") {
        router.refresh();
        return;
      }
      // Wrong code, or Paystack is still thinking about it — the server
      // action already reports which, in result.error.
      setOtpError(result.error ?? "That code wasn't accepted. Please try again.");
    } catch {
      setOtpError("Couldn't reach the server. Please try again.");
    } finally {
      setOtpSubmitting(false);
    }
  }

  useEffect(() => {
    // Once the charge has definitely failed there is nothing left to
    // poll for; re-running the effect with `declined` set simply stops.
    if (declined) return;

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
      if (Date.now() - startedAt > (awaitingOtp ? OTP_GIVE_UP_AFTER_MS : GIVE_UP_AFTER_MS)) return;

      // A slow round trip must not stack up behind itself — otherwise a
      // few seconds of latency turns into a queue of duplicate checks.
      checking.current = true;
      try {
        const result = await checkSalePayment(saleId);
        if (cancelled) return;
        if (result.error) setNote(result.error);

        // The customer said no, or the charge expired. Stop counting up
        // as though it might still land — nothing more will happen to
        // this tender, and the cashier has a queue.
        if (result.paymentStatus === "failed" || result.paymentStatus === "cancelled") {
          setDeclined(result.failureReason ?? "The customer did not approve it");
          return;
        }

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
    // awaitingOtp only decides which give-up window applies inside this
    // same effect run; it isn't expected to change for a given sale's
    // polling session (it reflects Paystack's initial answer to the
    // charge), but listing it keeps that assumption honest instead of
    // silently trusting a closure.
  }, [saleId, router, declined, awaitingOtp]);

  const seconds = Math.floor(elapsed / 1000);
  const expired = elapsed > (awaitingOtp ? OTP_GIVE_UP_AFTER_MS : GIVE_UP_AFTER_MS);

  if (declined) {
    return (
      <div className="rounded-2xl border border-red-300 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950/40">
        <h2 className="font-semibold text-red-900 dark:text-red-200">Payment declined</h2>
        <p className="mt-2 text-sm text-red-900/90 dark:text-red-200/90">
          {declined}. Nothing has been charged to {momoNumber ?? "their phone"}.
        </p>
        <p className="mt-3 text-sm text-red-900/70 dark:text-red-200/70">
          The items are still off the shelf against this sale. Cancel it to put them back, then take payment another
          way.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {canCancel ? (
            <StatusToggleButton
              action={cancelSale.bind(null, saleId)}
              label="Cancel sale and restock"
              pendingLabel="Cancelling…"
              variant="danger"
            />
          ) : null}
          <Button type="button" variant="secondary" onClick={() => router.refresh()}>
            Check again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-900 dark:bg-amber-950/40">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`h-2.5 w-2.5 rounded-full ${expired ? "bg-neutral-400" : "animate-pulse bg-amber-500"}`}
          aria-hidden="true"
        />
        <h2 className="font-semibold text-amber-900 dark:text-amber-200">
          {expired
            ? "No answer from the customer"
            : awaitingOtp
              ? "Enter the code Paystack texted the customer"
              : "Waiting for the customer to approve"}
        </h2>
      </div>

      <p className="mt-2 text-sm text-amber-900/90 dark:text-amber-200/90">
        {expired ? (
          <>
            The prompt to {momoNumber ?? "their phone"} has expired. Nothing has been charged. Cancel this sale to put
            the items back on the shelf, then try again.
          </>
        ) : awaitingOtp ? (
          otpPromptText ?? "Paystack sent a one-time code by SMS instead of a direct approval prompt. Ask the customer for it."
        ) : (
          <>
            {amount} was sent to {momoNumber ?? "their phone"} on {networkLabel}.{" "}
            {/* Paystack's own wording for this specific charge, when we have
                it, rather than a generic guess — the exact instructions
                differ by network (a PIN prompt, a USSD code to dial), and
                showing the real ones is what tells a cashier what to say
                to a confused customer. */}
            {otpPromptText ?? "They have about three minutes to approve it on their own handset."}
          </>
        )}
      </p>

      {!expired && !awaitingOtp ? (
        <p className="mt-1 text-sm text-amber-900/70 dark:text-amber-200/70">
          There is nothing to type here — {networkLabel} confirms this directly with the customer on their own
          phone, not through the till. If they mention getting a text or a code, that&apos;s for them to act on
          themselves, not something to read out to you.
        </p>
      ) : null}

      {!expired && awaitingOtp ? (
        <form onSubmit={handleSubmitOtp} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="momo-otp" className="text-xs font-medium text-amber-900/80 dark:text-amber-200/80">
              OTP code
            </label>
            <input
              id="momo-otp"
              name="otp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              disabled={otpSubmitting}
              className="w-36 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm tracking-widest text-amber-950 outline-none focus:border-amber-500 disabled:opacity-60 dark:border-amber-800 dark:bg-neutral-900 dark:text-amber-100"
              placeholder="123456"
            />
          </div>
          <Button type="submit" disabled={otpSubmitting || otp.trim().length === 0}>
            {otpSubmitting ? "Submitting…" : "Submit code"}
          </Button>
        </form>
      ) : null}

      {otpError ? <p className="mt-2 text-sm text-red-700 dark:text-red-300">{otpError}</p> : null}

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