"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import { Mail, Phone, MessageCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/button";
import { submitSupportRequest, type SupportRequestFormState } from "./support-actions";
import { supportEmail } from "@/lib/env";

// Busihub's own support contact — not the business's, and the same for
// every business on the platform. The email now comes from lib/env.ts's
// supportEmail() (safe to call client-side: NEXT_PUBLIC_ vars are inlined
// into the client bundle at build time) rather than its own separate
// hardcoded constant — this card used to hardcode a DIFFERENT address
// than every other page that shows Busihub's support contact, a real
// drift nobody had noticed until it was consolidated (see
// docs/ARCHITECTURE.md's changelog). The phone number keeps its own
// locally-formatted display constant below (Settings -> Billing shows
// the plain +233 form; this card's nicer "054 394 5668" spacing is
// cosmetic and not worth a shared formatter for one digit string).
const SUPPORT_PHONE_DISPLAY = "054 394 5668";
const SUPPORT_PHONE_TEL = "+233543945668";
const SUPPORT_WHATSAPP_URL = "https://wa.me/233543945668";

const initialState: SupportRequestFormState = {};

/**
 * "Need help?" — on every business's dashboard, not gated behind any
 * permission (asking for help isn't a privileged operation). Static
 * contact details plus an optional message, which lands in
 * support_requests (migration 0057) for the Super Admin console's
 * Support inbox to pick up — nothing here sends an email or notification
 * anywhere yet, by design (see this feature's docs/ARCHITECTURE.md entry).
 */
export function SupportCard() {
  const email = supportEmail();
  const [state, formAction] = useFormState(submitSupportRequest, initialState);
  // useFormState's own `state` only changes value (a fresh object) when a
  // submission actually completes, so it's the right thing to key "just
  // sent" off; a separate `sent` flag lets a second message be composed
  // and sent without a page reload.
  const [sent, setSent] = useState(false);
  // Adjusting state in response to another state value changing, done
  // during render rather than in a useEffect — the pattern React itself
  // recommends (see "You Might Not Need an Effect"): comparing against
  // the last-seen state and calling setState right here re-runs this
  // component once more before anything is painted, instead of the
  // effect-then-extra-render cascade a useEffect version would cause.
  const [prevState, setPrevState] = useState(state);
  if (state !== prevState) {
    setPrevState(state);
    if (state.success) setSent(true);
  }

  return (
    <Card className="p-5">
      <h2 className="font-semibold">Need help?</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
        Reach Busihub support directly, or send a message below.
      </p>

      <div className="mt-3 flex flex-col gap-2 text-sm">
        <a
          href={`mailto:${email}`}
          className="flex items-center gap-2 text-brand-700 hover:underline dark:text-brand-300"
        >
          <Mail className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          {email}
        </a>
        <a
          href={`tel:${SUPPORT_PHONE_TEL}`}
          className="flex items-center gap-2 text-brand-700 hover:underline dark:text-brand-300"
        >
          <Phone className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          {SUPPORT_PHONE_DISPLAY}
        </a>
        <a
          href={SUPPORT_WHATSAPP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-brand-700 hover:underline dark:text-brand-300"
        >
          <MessageCircle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          WhatsApp
        </a>
      </div>

      {sent ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-green-50 px-3.5 py-2.5 text-sm text-green-800 dark:bg-green-950/40 dark:text-green-300">
          <span>Sent — we&apos;ll get back to you.</span>
          <button
            type="button"
            onClick={() => setSent(false)}
            className="whitespace-nowrap font-medium underline underline-offset-2"
          >
            Send another
          </button>
        </div>
      ) : (
        <form action={formAction} className="mt-4 flex flex-col gap-2" noValidate>
          {state.error ? (
            <p
              role="alert"
              className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
            >
              {state.error}
            </p>
          ) : null}
          <textarea
            name="message"
            rows={3}
            placeholder="Or type a message and send it straight to us…"
            required
            className="w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-sm text-neutral-900 focus:border-lime-500 focus:outline-none focus:ring-2 focus:ring-lime-400/40 dark:border-surface-line dark:bg-surface dark:text-ink"
          />
          <SubmitButton variant="secondary" pendingText="Sending…" className="self-start">
            Send message
          </SubmitButton>
        </form>
      )}
    </Card>
  );
}