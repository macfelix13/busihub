import { createServiceRoleClient } from "@/lib/supabase/server";
import { loadPaystackCredentials, resolveBusinessIdFromWebhookParam } from "@/lib/paystack/client";
import { verifyWebhookSignature } from "@/lib/paystack/webhook";

/**
 * Best-effort audit trail for the two security-relevant things that can
 * happen to a webhook before it is ever trusted: a bad signature, and a
 * duplicate Paystack already retried. Never lets a logging failure turn
 * into a failed webhook response — Paystack would just retry an event
 * that was, in fact, already handled correctly.
 */
async function recordWebhookSecurityEvent(
  admin: ReturnType<typeof createServiceRoleClient>,
  businessId: string,
  action: string,
  metadata: Record<string, unknown>
) {
  const { error } = await admin.rpc("log_audit_event", {
    p_business_id: businessId,
    p_branch_id: null,
    p_action: action,
    p_resource_type: "business_payment_settings",
    p_resource_id: null,
    p_metadata: metadata,
  });
  if (error) {
    console.error("recordWebhookSecurityEvent: log_audit_event failed", { action, error });
  }
}

/**
 * Where Paystack tells us a mobile money charge succeeded.
 *
 * The URL carries the business id because every shop connects its OWN
 * Paystack account: each pastes its own copy of this URL into its own
 * dashboard, and the signature on an incoming event is checked against
 * that shop's own secret key. Without the id in the path we would have to
 * try every shop's secret against every event, which is both slow and a
 * way to leak which secrets exist.
 *
 * Three things this handler is careful about:
 *
 *   1. The signature is computed over the RAW body. Re-serialising parsed
 *      JSON produces a different string for the same payload, so the
 *      check would fail for honest requests and look like an attack.
 *
 *   2. It is idempotent. Paystack retries every 3 minutes for 4 attempts
 *      and then hourly for 72 hours until it receives a 200, so the same
 *      event arriving repeatedly is the ordinary case. The event is
 *      recorded first; a duplicate stops there.
 *
 *   3. A verified signature proves which BUSINESS is calling, not which
 *      payment it may touch. The business id is passed down to
 *      settle_sale_payment, which refuses a payment belonging to anyone
 *      else (migration 0023).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PaystackEvent {
  event?: string;
  data?: {
    id?: number | string;
    reference?: string;
    status?: string;
    gateway_response?: string;
  };
}

export async function POST(request: Request, { params }: { params: Promise<{ businessId: string }> }) {
  const { businessId: rawParam } = await params;

  // Read the body exactly as sent, before anything parses it.
  const rawBody = await request.text();

  // The URL segment is no longer necessarily a raw business_id — see
  // resolveBusinessIdFromWebhookParam's own comment (migration 0047).
  const businessId = await resolveBusinessIdFromWebhookParam(rawParam);
  if (!businessId) {
    return new Response("Unknown business", { status: 404 });
  }

  const admin = createServiceRoleClient();

  const credentials = await loadPaystackCredentials(businessId);
  if (!credentials) {
    // Either an unknown business or one that has not connected an
    // account. Nothing to verify against, so nothing is trusted.
    return new Response("Unknown business", { status: 404 });
  }

  if (!verifyWebhookSignature(rawBody, request.headers.get("x-paystack-signature"), credentials.secretKey)) {
    await recordWebhookSecurityEvent(admin, businessId, "paystack_webhook.invalid_signature", {});
    return new Response("Invalid signature", { status: 401 });
  }

  let event: PaystackEvent;
  try {
    event = JSON.parse(rawBody) as PaystackEvent;
  } catch {
    // Signed by the right key but not JSON. Accepted so it is not retried
    // for three days; there is nothing here to act on.
    console.error("paystack webhook: signed body was not JSON", { businessId });
    return new Response("OK", { status: 200 });
  }

  // Paystack does not send a dedicated event id, so the event name and
  // the transaction it concerns identify it: a retry repeats both, while
  // two different events about the same transaction differ by name.
  const eventKey = `${event.event ?? "unknown"}:${event.data?.id ?? event.data?.reference ?? "none"}`;

  const { error: seenError } = await admin.from("paystack_events").insert({
    id: eventKey,
    business_id: businessId,
    event_type: event.event ?? "unknown",
    payload: event as unknown as Record<string, unknown>,
  });

  if (seenError) {
    // 23505 is the primary key: we have already handled this one. Any
    // other error means we could not record it, and acting on an event we
    // cannot mark as seen risks doing it twice — so ask for a retry.
    if (seenError.code === "23505") {
      await recordWebhookSecurityEvent(admin, businessId, "paystack_webhook.duplicate_ignored", {
        event_type: event.event ?? "unknown",
      });
      return new Response("OK", { status: 200 });
    }
    console.error("paystack webhook: could not record event", seenError);
    return new Response("Could not record event", { status: 500 });
  }

  const name = event.event ?? "";
  if (name !== "charge.success" && name !== "charge.failed") {
    // Refunds, transfers, disputes — nothing this phase acts on. A 200
    // stops Paystack retrying it for three days.
    return new Response("OK", { status: 200 });
  }

  const reference = event.data?.reference;
  if (!reference) {
    console.error("paystack webhook: charge event with no reference", { businessId, name });
    return new Response("OK", { status: 200 });
  }

  // A shop's Paystack account is its own: it may take payments from a
  // website, an invoice link, or a second system, and every one of those
  // events arrives here too. Our references are the payment row's uuid,
  // so anything that is not one was never ours to settle. Without this
  // the RPC would fail on the cast (22P02) and we would answer 500 to a
  // webhook that is perfectly valid and simply not about us.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference)) {
    return new Response("OK", { status: 200 });
  }

  const { error: settleError } = await admin.rpc("settle_sale_payment", {
    p_business_id: businessId,
    // The reference we sent is the payment row's own id.
    p_payment_id: reference,
    p_status: name === "charge.success" ? "success" : "failed",
    p_provider_charge_id: event.data?.id != null ? String(event.data.id) : null,
    p_failure_reason: name === "charge.failed" ? (event.data?.gateway_response ?? "Payment failed") : null,
  });

  if (settleError) {
    // P0002 (no such payment) and 42501 (belongs to another business) are
    // final answers, not transient failures — retrying for 72 hours would
    // not change them, so they are acknowledged and logged.
    if (settleError.code === "P0002" || settleError.code === "42501") {
      console.error("paystack webhook: event does not match a payment we can settle", {
        businessId,
        reference,
        code: settleError.code,
      });
      return new Response("OK", { status: 200 });
    }
    // Anything else is transient (the database was unreachable, a lock
    // timed out). We asked to be retried — but the event was recorded
    // BEFORE this ran, and the guard above would turn every retry into an
    // instant 200, losing the settlement forever. So the record is
    // withdrawn: the replay guard exists to stop an event being acted on
    // twice, not to stop it being acted on at all.
    console.error("paystack webhook: settlement failed", settleError);
    const { error: undoError } = await admin.from("paystack_events").delete().eq("id", eventKey);
    if (undoError) {
      console.error("paystack webhook: could not withdraw the event record — retries will be dropped", undoError);
    }
    return new Response("Settlement failed", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}