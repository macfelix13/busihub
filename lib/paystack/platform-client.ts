import "server-only";
import { paystackPlatformSecretKey } from "@/lib/env";

/**
 * Paystack, for Busihub's OWN account — not a shop's.
 *
 * Everything in lib/paystack/client.ts is per-shop: each business
 * connects its own Paystack account so it can collect from its own
 * customers, and the credentials are looked up per business_id. This
 * module is the opposite direction — Busihub billing a BUSINESS for its
 * own subscription — and there is exactly one set of credentials for it,
 * read once from the environment (lib/env.ts), never looked up per
 * business and never stored in this database at all. The two modules
 * share no runtime code on purpose, so a mistake in one can't reach into
 * the other's credentials.
 *
 * Grew in two deliveries (see migration 0060's own header): plan sync
 * first (createOrUpdatePaystackPlan, used by Super Admin's /admin/plans),
 * now checkout/cancellation (initializeSubscriptionCheckout,
 * verifyPlatformTransaction, disableSubscription — used by
 * app/(app)/settings/billing and the platform webhook).
 *
 * IMPORTANT, stated plainly rather than implied: everything below is
 * written to Paystack's own documented REST contract, but has NOT been
 * exercised against a real Paystack account from this environment (no
 * live credentials are reachable here). It must be run once against
 * real Paystack TEST-mode keys — create a plan, run a full subscribe
 * flow with a test card, confirm the webhook actually lands and matches
 * what app/api/webhooks/paystack-platform/route.ts expects — before it
 * is trusted with a live key.
 */

const API = "https://api.paystack.co";

function requireSecretKey(): string {
  const key = paystackPlatformSecretKey();
  if (!key) {
    throw new Error(
      "PAYSTACK_PLATFORM_SECRET_KEY is not set — Busihub's own Paystack account isn't configured yet."
    );
  }
  return key;
}

export type PaystackPlanInterval = "monthly" | "annually";

export interface PlanSyncResult {
  ok: boolean;
  /** Paystack's own plan_code, only set when ok is true. */
  planCode: string | null;
  /** Present when ok is false — safe to show a Super Admin, never a raw stack trace. */
  message: string | null;
}

interface PaystackPlanResponse {
  status?: boolean;
  message?: string;
  data?: { plan_code?: string };
}

/**
 * Creates a new Paystack Plan (existingPlanCode is null) or updates the
 * one this subscription_plans row is already linked to (existingPlanCode
 * is set) — the caller (app/admin/plans/actions.ts) decides which by
 * reading the row's own paystack_plan_code column first.
 *
 * amountMinorUnits is pesewas/kobo (Paystack's own minor unit), same
 * convention as lib/money/money.ts's toMinorUnits() — never pass a major-
 * unit decimal amount here.
 *
 * Deliberately never throws for an ordinary Paystack-side rejection (bad
 * amount, unreachable network, invalid key) — every one of those comes
 * back as { ok: false, message }, so a sync failure can be treated as
 * best-effort by the caller (log it, keep the plan's existing/null code,
 * don't block the save) rather than as an uncaught exception taking down
 * an otherwise-successful admin action.
 */
export async function createOrUpdatePaystackPlan(params: {
  existingPlanCode: string | null;
  name: string;
  amountMinorUnits: number;
  interval: PaystackPlanInterval;
  currencyCode: string;
  description: string | null;
}): Promise<PlanSyncResult> {
  const { existingPlanCode, name, amountMinorUnits, interval, currencyCode, description } = params;

  let secretKey: string;
  try {
    secretKey = requireSecretKey();
  } catch (err) {
    console.error("createOrUpdatePaystackPlan: no platform secret key configured", err);
    return { ok: false, planCode: null, message: "Busihub's Paystack account isn't configured yet." };
  }

  const url = existingPlanCode ? `${API}/plan/${encodeURIComponent(existingPlanCode)}` : `${API}/plan`;
  const method = existingPlanCode ? "PUT" : "POST";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        amount: amountMinorUnits,
        interval,
        currency: currencyCode,
        description: description ?? undefined,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error("createOrUpdatePaystackPlan: request failed", err);
    return { ok: false, planCode: null, message: "Couldn't reach Paystack." };
  }

  const body = (await response.json().catch(() => null)) as PaystackPlanResponse | null;

  if (!response.ok || !body?.status) {
    console.error("createOrUpdatePaystackPlan: Paystack rejected the request", {
      status: response.status,
      message: body?.message,
    });
    return {
      ok: false,
      planCode: null,
      message: body?.message ?? `Paystack refused the request (HTTP ${response.status}).`,
    };
  }

  // Paystack's documented PUT /plan/:code response does not consistently
  // echo plan_code back on an update the way POST /plan does on create —
  // when it's missing, the plan we just updated is still the one we sent
  // existingPlanCode for, so that's what's kept rather than treating a
  // successful update as a failure over a field we already know.
  const planCode = body.data?.plan_code ?? existingPlanCode ?? null;
  if (!planCode) {
    console.error("createOrUpdatePaystackPlan: Paystack accepted the request but returned no plan_code", body);
    return { ok: false, planCode: null, message: "Paystack didn't return a plan code." };
  }

  return { ok: true, planCode, message: null };
}

export interface CheckoutInitResult {
  ok: boolean;
  authorizationUrl: string | null;
  message: string | null;
}

interface PaystackInitializeResponse {
  status?: boolean;
  message?: string;
  data?: { authorization_url?: string; access_code?: string; reference?: string };
}

/**
 * Starts a hosted Paystack checkout for one billing period of a plan —
 * the caller (app/(app)/settings/billing/actions.ts) redirects the
 * business's browser to the returned authorization_url. Passing `plan`
 * rather than `amount` is what makes Paystack treat this as a
 * subscription checkout: on a successful charge, Paystack creates the
 * subscription itself and bills `reference`'s email/card automatically
 * every period after this one — nothing in this codebase re-initiates
 * future charges.
 *
 * `reference` must be one this app generated itself (start_plan_checkout(),
 * migration 0061) and already recorded in platform_billing_checkouts —
 * that row is how the webhook (app/api/webhooks/paystack-platform) tells
 * this specific checkout's charge.success apart from a routine renewal's.
 */
export async function initializeSubscriptionCheckout(params: {
  email: string;
  planCode: string;
  reference: string;
  callbackUrl: string;
  metadata: Record<string, unknown>;
}): Promise<CheckoutInitResult> {
  const { email, planCode, reference, callbackUrl, metadata } = params;

  let secretKey: string;
  try {
    secretKey = requireSecretKey();
  } catch (err) {
    console.error("initializeSubscriptionCheckout: no platform secret key configured", err);
    return { ok: false, authorizationUrl: null, message: "Busihub's Paystack account isn't configured yet." };
  }

  let response: Response;
  try {
    response = await fetch(`${API}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        plan: planCode,
        reference,
        callback_url: callbackUrl,
        metadata,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error("initializeSubscriptionCheckout: request failed", err);
    return { ok: false, authorizationUrl: null, message: "Couldn't reach Paystack." };
  }

  const body = (await response.json().catch(() => null)) as PaystackInitializeResponse | null;

  if (!response.ok || !body?.status || !body.data?.authorization_url) {
    console.error("initializeSubscriptionCheckout: Paystack rejected the request", {
      status: response.status,
      message: body?.message,
    });
    return {
      ok: false,
      authorizationUrl: null,
      message: body?.message ?? `Paystack refused the request (HTTP ${response.status}).`,
    };
  }

  return { ok: true, authorizationUrl: body.data.authorization_url, message: null };
}

export interface PlatformVerifyResult {
  status: "success" | "failed" | "pending";
  message: string | null;
}

/**
 * Purely informational — used only to word the "processing"/"failed"
 * banner on the return leg of checkout (app/(app)/settings/billing).
 * Never writes anything, never decides whether the business is actually
 * on the new plan: only the webhook's own platform_billing_activate_subscription()
 * call does that, exactly the same "don't trust the redirect, trust the
 * webhook" rule as the per-shop side's verifyTransaction().
 */
export async function verifyPlatformTransaction(reference: string): Promise<PlatformVerifyResult | null> {
  let secretKey: string;
  try {
    secretKey = requireSecretKey();
  } catch (err) {
    console.error("verifyPlatformTransaction: no platform secret key configured", err);
    return null;
  }

  let response: Response;
  try {
    response = await fetch(`${API}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch (err) {
    console.error("verifyPlatformTransaction: request failed", err);
    return null;
  }

  const body = (await response.json().catch(() => null)) as {
    status?: boolean;
    data?: { status?: string; gateway_response?: string };
  } | null;

  if (!response.ok || !body?.status || !body.data) {
    return null;
  }

  const rawStatus = body.data.status;
  const status: "success" | "failed" | "pending" =
    rawStatus === "success" ? "success" : rawStatus === "failed" || rawStatus === "abandoned" ? "failed" : "pending";

  return { status, message: body.data.gateway_response ?? null };
}

export interface DisableSubscriptionResult {
  ok: boolean;
  message: string | null;
}

/**
 * Asks Paystack to stop future auto-renewal for one subscription — never
 * called with anything other than a code/token this app already read
 * back from its own business_subscriptions row (set by
 * platform_billing_link_subscription()). Does not itself change
 * anything in this database: cancel_at_period_end is only ever set once
 * Paystack's own subscription.disable event confirms it
 * (platform_billing_record_cancel_scheduled(), migration 0061) — same
 * "webhook is the only source of truth" rule as everywhere else in this
 * module.
 */
export async function disableSubscription(params: { code: string; token: string }): Promise<DisableSubscriptionResult> {
  let secretKey: string;
  try {
    secretKey = requireSecretKey();
  } catch (err) {
    console.error("disableSubscription: no platform secret key configured", err);
    return { ok: false, message: "Busihub's Paystack account isn't configured yet." };
  }

  let response: Response;
  try {
    response = await fetch(`${API}/subscription/disable`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: params.code, token: params.token }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error("disableSubscription: request failed", err);
    return { ok: false, message: "Couldn't reach Paystack." };
  }

  const body = (await response.json().catch(() => null)) as { status?: boolean; message?: string } | null;

  if (!response.ok || !body?.status) {
    console.error("disableSubscription: Paystack rejected the request", { status: response.status, message: body?.message });
    return { ok: false, message: body?.message ?? `Paystack refused the request (HTTP ${response.status}).` };
  }

  return { ok: true, message: null };
}