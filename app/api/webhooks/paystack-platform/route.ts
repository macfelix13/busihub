import { createServiceRoleClient } from "@/lib/supabase/server";
import { verifyWebhookSignature } from "@/lib/paystack/webhook";
import { paystackPlatformSecretKey } from "@/lib/env";

/**
 * Where Paystack tells us about Busihub's OWN subscription billing — a
 * business's card/mobile money being auto-charged for its Busihub plan.
 * This is a completely separate integration from
 * app/api/webhooks/paystack/[businessId] (a SHOP's own Paystack account,
 * collecting from ITS OWN customers): one fixed URL, one fixed secret
 * key (PAYSTACK_PLATFORM_SECRET_KEY), no per-business lookup at all.
 *
 * Same three disciplines as the per-shop webhook, for the same reasons
 * (see that route's own comment): the signature is checked against the
 * RAW body; every event is recorded (platform_paystack_events, migration
 * 0061) before anything acts on it, so a retry — Paystack retries for up
 * to 72 hours — is a safe no-op; and nothing here ever trusts a
 * client-supplied "it worked" — every state change goes through one of
 * five dedicated, audited SQL functions (migration 0061), never a raw
 * UPDATE from this route.
 *
 * IMPORTANT — read before touching this file. The exact field names read
 * below (event.data.customer.customer_code, event.data.next_payment_date,
 * which of several plausible places an invoice event nests its
 * subscription code under) are written to Paystack's own documented
 * Subscriptions/Invoices contract as closely as this project's authors
 * could verify WITHOUT a reachable Paystack account from the sandbox
 * this was built in. Several reads below check more than one plausible
 * field location defensively for exactly that reason — not because the
 * shape is expected to vary, but because it has not been confirmed
 * against a real event. Every failure mode here is designed to degrade
 * safely (a field that isn't found just means that one detail doesn't
 * update this cycle, never a crash and never a wrongly-activated
 * business) but this still needs a real Paystack TEST-mode subscription
 * run-through — subscribe with a test card, watch each event actually
 * arrive and match what this file expects — before it is trusted with a
 * live key. See migration 0061's own file header for the same caveat
 * from the database side.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Admin = ReturnType<typeof createServiceRoleClient>;

interface PaystackPlatformEvent {
  event?: string;
  data?: {
    id?: number | string;
    reference?: string;
    status?: string;
    message?: string;
    customer?: { customer_code?: string; email?: string };
    subscription_code?: string;
    email_token?: string;
    next_payment_date?: string;
    period_end?: string;
    subscription?: { subscription_code?: string; next_payment_date?: string };
  };
}

/**
 * Best-effort platform-level audit trail for the two security-relevant
 * things that can happen before an event is ever trusted — same
 * reasoning, and the same "never let a logging failure turn into a
 * failed webhook response" rule, as the per-shop webhook's own
 * recordWebhookSecurityEvent(). business_id is always null here: these
 * are events about the webhook itself, not about any one business.
 */
async function recordWebhookSecurityEvent(admin: Admin, action: string, metadata: Record<string, unknown>) {
  const { error } = await admin.rpc("log_audit_event", {
    p_business_id: null,
    p_branch_id: null,
    p_action: action,
    p_resource_type: "platform_billing",
    p_resource_id: null,
    p_metadata: metadata,
  });
  if (error) {
    console.error("recordWebhookSecurityEvent (platform): log_audit_event failed", { action, error });
  }
}

async function findBusinessIdBySubscriptionCode(admin: Admin, subscriptionCode: string): Promise<string | null> {
  const { data, error } = await admin
    .from("business_subscriptions")
    .select("business_id")
    .eq("paystack_subscription_code", subscriptionCode)
    .maybeSingle();
  if (error) {
    throw new Error(`business lookup by paystack_subscription_code failed: ${error.message}`);
  }
  return (data as { business_id: string } | null)?.business_id ?? null;
}

/**
 * The FIRST charge of a new self-serve subscription — matched by OUR OWN
 * reference (start_plan_checkout(), migration 0061), never by metadata
 * alone, so a business/plan pair can't be spoofed by anything in the
 * webhook payload itself: reference has to already exist in
 * platform_billing_checkouts, a row this app created server-side before
 * the business was ever sent to Paystack. A renewal's charge.success
 * uses a reference Paystack generates itself and will simply not match
 * any row here — handled by invoice.update below instead.
 */
async function handleChargeSuccess(admin: Admin, event: PaystackPlatformEvent) {
  const reference = event.data?.reference;
  const customerCode = event.data?.customer?.customer_code;
  if (!reference) return;

  const { data: checkout, error: checkoutError } = await admin
    .from("platform_billing_checkouts")
    .select("business_id, plan_id, consumed_at")
    .eq("reference", reference)
    .maybeSingle();
  if (checkoutError) {
    throw new Error(`checkout lookup failed: ${checkoutError.message}`);
  }
  if (!checkout) return; // not a self-serve checkout we started — a renewal, most likely.

  const row = checkout as { business_id: string; plan_id: string; consumed_at: string | null };
  if (row.consumed_at) return; // already activated once.

  if (!customerCode) {
    console.error("handleChargeSuccess: charge.success matched a checkout but had no customer_code", event.data);
    return;
  }

  const { error: activateError } = await admin.rpc("platform_billing_activate_subscription", {
    p_business_id: row.business_id,
    p_plan_id: row.plan_id,
    p_paystack_customer_code: customerCode,
  });
  if (activateError) {
    throw new Error(`platform_billing_activate_subscription failed: ${activateError.message}`);
  }

  const { error: consumeError } = await admin
    .from("platform_billing_checkouts")
    .update({ consumed_at: new Date().toISOString() })
    .eq("reference", reference);
  if (consumeError) {
    // Not fatal to this request — the subscription is already active,
    // which is the part that matters. A checkout row that never gets
    // marked consumed just means a hypothetical duplicate charge.success
    // for the exact same reference would re-run this block once more
    // (platform_billing_activate_subscription is idempotent either way,
    // since it always just re-asserts the same active state).
    console.error("handleChargeSuccess: could not mark checkout consumed", consumeError);
  }
}

/**
 * Paystack's OWN subscription.create event — arrives separately from,
 * and with no guaranteed ordering against, the charge.success above. Has
 * no reference field of its own to match against platform_billing_checkouts,
 * so this matches by paystack_customer_code instead — set moments
 * earlier by handleChargeSuccess(), and the one identifier both events
 * are confident to share.
 */
async function handleSubscriptionCreate(admin: Admin, event: PaystackPlatformEvent) {
  const subscriptionCode = event.data?.subscription_code;
  const customerCode = event.data?.customer?.customer_code;
  if (!subscriptionCode || !customerCode) {
    console.error("handleSubscriptionCreate: missing subscription_code or customer_code", event.data);
    return;
  }

  const { data: subscription, error } = await admin
    .from("business_subscriptions")
    .select("business_id")
    .eq("paystack_customer_code", customerCode)
    .maybeSingle();
  if (error) {
    throw new Error(`business lookup by customer_code failed: ${error.message}`);
  }
  const businessId = (subscription as { business_id: string } | null)?.business_id ?? null;
  if (!businessId) {
    // Order-of-arrival edge case: subscription.create landed before the
    // charge.success that sets paystack_customer_code. Acknowledged, not
    // retried forever — if this genuinely matters it will also show up
    // as a business stuck without a paystack_subscription_code, visible
    // on its own Settings -> Billing page.
    console.error("handleSubscriptionCreate: no business found yet for customer_code", customerCode);
    return;
  }

  const { error: linkError } = await admin.rpc("platform_billing_link_subscription", {
    p_business_id: businessId,
    p_paystack_subscription_code: subscriptionCode,
    p_paystack_email_token: event.data?.email_token ?? null,
    p_current_period_end: event.data?.next_payment_date ?? null,
  });
  if (linkError) {
    throw new Error(`platform_billing_link_subscription failed: ${linkError.message}`);
  }
}

async function handlePaymentFailed(admin: Admin, event: PaystackPlatformEvent) {
  const subscriptionCode = event.data?.subscription?.subscription_code ?? event.data?.subscription_code;
  if (!subscriptionCode) {
    console.error("handlePaymentFailed: no subscription code on invoice.payment_failed", event.data);
    return;
  }
  const businessId = await findBusinessIdBySubscriptionCode(admin, subscriptionCode);
  if (!businessId) return;

  const { error } = await admin.rpc("platform_billing_record_payment_failed", {
    p_business_id: businessId,
    p_failure_reason: event.data?.message ?? null,
  });
  if (error) {
    throw new Error(`platform_billing_record_payment_failed failed: ${error.message}`);
  }
}

/**
 * A RENEWAL charge succeeding arrives as invoice.update with a success
 * status, per Paystack's documented model — distinct from the very first
 * subscribe charge (charge.success, handled above) and never matched
 * against platform_billing_checkouts, since a renewal's invoice was
 * never one this app initiated a checkout for.
 */
async function handleInvoiceUpdate(admin: Admin, event: PaystackPlatformEvent) {
  if (event.data?.status !== "success") return;

  const subscriptionCode = event.data?.subscription?.subscription_code ?? event.data?.subscription_code;
  if (!subscriptionCode) {
    console.error("handleInvoiceUpdate: no subscription code on a successful invoice.update", event.data);
    return;
  }
  const businessId = await findBusinessIdBySubscriptionCode(admin, subscriptionCode);
  if (!businessId) return;

  const { error } = await admin.rpc("platform_billing_record_renewal", {
    p_business_id: businessId,
    p_current_period_end: event.data?.subscription?.next_payment_date ?? event.data?.next_payment_date ?? event.data?.period_end ?? null,
  });
  if (error) {
    throw new Error(`platform_billing_record_renewal failed: ${error.message}`);
  }
}

async function handleSubscriptionCancelled(admin: Admin, event: PaystackPlatformEvent) {
  const subscriptionCode = event.data?.subscription_code;
  if (!subscriptionCode) {
    console.error("handleSubscriptionCancelled: no subscription code", event.data);
    return;
  }
  const businessId = await findBusinessIdBySubscriptionCode(admin, subscriptionCode);
  if (!businessId) return;

  const { error } = await admin.rpc("platform_billing_record_cancel_scheduled", { p_business_id: businessId });
  if (error) {
    throw new Error(`platform_billing_record_cancel_scheduled failed: ${error.message}`);
  }
}

export async function POST(request: Request) {
  const secretKey = paystackPlatformSecretKey();
  if (!secretKey) {
    console.error("POST /api/webhooks/paystack-platform: PAYSTACK_PLATFORM_SECRET_KEY is not configured");
    return new Response("Not configured", { status: 500 });
  }

  const rawBody = await request.text();
  const admin = createServiceRoleClient();

  if (!verifyWebhookSignature(rawBody, request.headers.get("x-paystack-signature"), secretKey)) {
    await recordWebhookSecurityEvent(admin, "platform_paystack_webhook.invalid_signature", {});
    return new Response("Invalid signature", { status: 401 });
  }

  let event: PaystackPlatformEvent;
  try {
    event = JSON.parse(rawBody) as PaystackPlatformEvent;
  } catch {
    console.error("POST /api/webhooks/paystack-platform: signed body was not JSON");
    return new Response("OK", { status: 200 });
  }

  const name = event.event ?? "unknown";
  // Whichever identifier this event type actually carries — see this
  // file's own header on why the exact shape isn't fully verified yet.
  const eventKey = `${name}:${event.data?.subscription_code ?? event.data?.reference ?? event.data?.id ?? "none"}`;

  const { error: seenError } = await admin.from("platform_paystack_events").insert({
    id: eventKey,
    event_type: name,
    payload: event as unknown as Record<string, unknown>,
  });

  if (seenError) {
    if (seenError.code === "23505") {
      await recordWebhookSecurityEvent(admin, "platform_paystack_webhook.duplicate_ignored", { event_type: name });
      return new Response("OK", { status: 200 });
    }
    console.error("POST /api/webhooks/paystack-platform: could not record event", seenError);
    return new Response("Could not record event", { status: 500 });
  }

  try {
    if (name === "charge.success") {
      await handleChargeSuccess(admin, event);
    } else if (name === "subscription.create") {
      await handleSubscriptionCreate(admin, event);
    } else if (name === "invoice.payment_failed") {
      await handlePaymentFailed(admin, event);
    } else if (name === "invoice.update") {
      await handleInvoiceUpdate(admin, event);
    } else if (name === "subscription.disable" || name === "subscription.not_renew") {
      await handleSubscriptionCancelled(admin, event);
    }
    // Every other event type (invoice.create, transfer.*, …): acknowledged,
    // nothing this integration acts on — same as the per-shop webhook's
    // own handling of events outside its own two.
  } catch (err) {
    console.error(`POST /api/webhooks/paystack-platform: handling "${name}" failed`, err);
    // Withdraw the event record so a genuinely transient failure (the
    // database unreachable, a lock timeout) gets retried by Paystack
    // instead of being treated as already-handled forever — same
    // recovery shape as the per-shop webhook route's own undo-on-failure
    // step.
    const { error: undoError } = await admin.from("platform_paystack_events").delete().eq("id", eventKey);
    if (undoError) {
      console.error("POST /api/webhooks/paystack-platform: could not withdraw the event record — retries will be dropped", undoError);
    }
    return new Response("Handling failed", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}