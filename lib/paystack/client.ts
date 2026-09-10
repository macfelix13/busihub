import "server-only";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { decryptSecret } from "@/lib/crypto/secret-box";

/**
 * Paystack, per shop.
 *
 * Every business collects into its own Paystack account, so there is no
 * single API key here: the credentials are loaded per business and the
 * secret is decrypted only inside this module, only on the server, and
 * only for the length of one request.
 *
 * What this file deliberately does NOT do is decide anything about money.
 * It asks Paystack to charge an amount the database computed, and it
 * reports back what Paystack said. Every rule about whether a sale is
 * paid lives in settle_sale_payment().
 */

const API = "https://api.paystack.co";

export interface PaystackCredentials {
  secretKey: string;
  publicKey: string | null;
  isLive: boolean;
  momoEnabled: boolean;
}

/**
 * Loads a business's Paystack credentials with the SERVICE-ROLE client,
 * because the ciphertext column is not selectable by any ordinary user —
 * that is the whole point of the column grants in migration 0022.
 *
 * Returns null when the shop has not connected an account yet, which is
 * the normal state for a business that only takes cash.
 */
export async function loadPaystackCredentials(businessId: string): Promise<PaystackCredentials | null> {
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("business_payment_settings")
    .select("paystack_public_key, paystack_secret_cipher, is_live, momo_enabled")
    .eq("business_id", businessId)
    .maybeSingle();

  if (error) {
    console.error("loadPaystackCredentials: query failed", error);
    return null;
  }

  const row = data as {
    paystack_public_key: string | null;
    paystack_secret_cipher: string | null;
    is_live: boolean;
    momo_enabled: boolean;
  } | null;

  if (!row?.paystack_secret_cipher) {
    return null;
  }

  try {
    return {
      secretKey: decryptSecret(row.paystack_secret_cipher),
      publicKey: row.paystack_public_key,
      isLive: row.is_live,
      momoEnabled: row.momo_enabled,
    };
  } catch (err) {
    // A key that will not decrypt means PAYSTACK_KEY_ENCRYPTION_KEY has
    // changed since it was stored. Say so plainly rather than letting it
    // surface as a mystifying Paystack auth failure later.
    console.error("loadPaystackCredentials: stored secret could not be decrypted", err);
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turns the path segment on an incoming Paystack webhook URL into the
 * business it belongs to.
 *
 * A shop's webhook URL is /api/webhooks/paystack/[businessId] in the
 * route's own folder name, but the value that arrives there is no longer
 * necessarily a business_id — migration 0047 gives every shop its own
 * webhook_identifier, decoupled from business_id on purpose (see that
 * migration's header). This checks the new column FIRST, and falls back
 * to treating the value as a raw business_id only if that fails — which
 * is exactly the URL a shop that connected before 0047 already has
 * pasted into its Paystack dashboard. That shop never has to notice
 * anything changed; only a shop that regenerates its identifier moves off
 * the fallback.
 *
 * Getting this wrong in either direction only ever means the webhook is
 * NOT recognised (a 404 the caller below turns into "Unknown business") —
 * it can never point traffic at the wrong business, because whichever
 * business_id this returns still has to pass the HMAC signature check
 * with that exact business's own secret key before anything is trusted.
 */
export async function resolveBusinessIdFromWebhookParam(param: string): Promise<string | null> {
  if (!UUID_RE.test(param)) return null;

  const admin = createServiceRoleClient();

  const { data: byIdentifier, error: identifierError } = await admin
    .from("business_payment_settings")
    .select("business_id")
    .eq("webhook_identifier", param)
    .maybeSingle();

  if (identifierError) {
    console.error("resolveBusinessIdFromWebhookParam: identifier lookup failed", identifierError);
  }
  if (byIdentifier) {
    return (byIdentifier as { business_id: string }).business_id;
  }

  const { data: byBusinessId, error: businessIdError } = await admin
    .from("business_payment_settings")
    .select("business_id")
    .eq("business_id", param)
    .maybeSingle();

  if (businessIdError) {
    console.error("resolveBusinessIdFromWebhookParam: business_id lookup failed", businessIdError);
  }
  if (byBusinessId) {
    return (byBusinessId as { business_id: string }).business_id;
  }

  return null;
}

export type MomoNetwork = "mtn" | "vod" | "atl";

export interface ChargeResult {
  ok: boolean;
  /** Paystack's own transaction id, kept so a charge can be traced later. */
  chargeId: string | null;
  /** Paystack's own reference for this charge — required to submit an OTP against it. */
  reference: string | null;
  /**
   * 'pending' while the customer has not answered the prompt yet.
   * 'otp_required' is a distinct kind of pending: Paystack texted the
   * customer a one-time code and is waiting on a SEPARATE submit_otp call
   * before it will settle at all — a plain "still waiting" retry loop
   * never resolves this one.
   */
  status: "pending" | "otp_required" | "success" | "failed";
  /** Paystack's wording for the customer, e.g. "Please approve on your phone". */
  displayText: string | null;
  message: string | null;
}

/**
 * Asks Paystack to prompt a customer's phone. The customer has 180
 * seconds to approve; the answer arrives on the webhook, or is read back
 * by verifyTransaction() if the webhook is slow.
 *
 * `amount` is in major units (cedis) and converted here — Paystack takes
 * the minor unit, and getting that wrong is a factor-of-100 error in
 * either direction.
 */
export async function chargeMobileMoney(params: {
  credentials: PaystackCredentials;
  email: string;
  amount: number;
  reference: string;
  phone: string;
  network: MomoNetwork;
}): Promise<ChargeResult> {
  const { credentials, email, amount, reference, phone, network } = params;

  let response: Response;
  try {
    response = await fetch(`${API}/charge`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: Math.round(amount * 100),
        currency: "GHS",
        reference,
        mobile_money: { phone, provider: network },
      }),
      // A till cannot hang waiting for a network that is not answering.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error("chargeMobileMoney: request failed", err);
    return {
      ok: false,
      chargeId: null,
      reference: null,
      status: "failed",
      displayText: null,
      message: "Couldn't reach Paystack.",
    };
  }

  const body = (await response.json().catch(() => null)) as {
    status?: boolean;
    message?: string;
    data?: {
      id?: number | string;
      status?: string;
      display_text?: string;
      gateway_response?: string;
      reference?: string;
    };
  } | null;

  if (!response.ok || !body?.status) {
    return {
      ok: false,
      chargeId: null,
      reference: null,
      status: "failed",
      displayText: null,
      message: body?.message ?? `Paystack refused the charge (HTTP ${response.status}).`,
    };
  }

  return {
    ok: true,
    chargeId: body.data?.id != null ? String(body.data.id) : null,
    reference: body.data?.reference ?? reference,
    status: normaliseStatus(body.data?.status),
    displayText: body.data?.display_text ?? null,
    message: body.message ?? null,
  };
}

/**
 * The second half of the send_otp flow: the customer read the code off an
 * SMS, the cashier typed it in, and this is the ONLY way Paystack will
 * actually settle a charge that asked for one — polling verifyTransaction()
 * or waiting for a webhook never resolves it, because Paystack is waiting
 * on this call before it decides anything.
 *
 * Mirrors chargeMobileMoney()'s own fetch/timeout/error-handling shape
 * exactly, on purpose: same 20s budget a till cannot hang past, same
 * "anything not a clear yes/no is still pending" treatment via
 * normaliseStatus(), same shape of result the caller already knows how to
 * read.
 */
export async function submitChargeOtp(
  credentials: PaystackCredentials,
  reference: string,
  otp: string
): Promise<ChargeResult> {
  let response: Response;
  try {
    response = await fetch(`${API}/charge/submit_otp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ otp, reference }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error("submitChargeOtp: request failed", err);
    return {
      ok: false,
      chargeId: null,
      reference,
      status: "failed",
      displayText: null,
      message: "Couldn't reach Paystack.",
    };
  }

  const body = (await response.json().catch(() => null)) as {
    status?: boolean;
    message?: string;
    data?: { id?: number | string; status?: string; display_text?: string; reference?: string };
  } | null;

  if (!response.ok || !body?.status) {
    // A wrong or expired code lands here as a normal, retryable failure —
    // not a terminal one. The caller decides whether to let the cashier
    // try again; this function only reports what Paystack said.
    return {
      ok: false,
      chargeId: null,
      reference,
      status: "failed",
      displayText: null,
      message: body?.message ?? `Paystack rejected the code (HTTP ${response.status}).`,
    };
  }

  return {
    ok: true,
    chargeId: body.data?.id != null ? String(body.data.id) : null,
    reference: body.data?.reference ?? reference,
    status: normaliseStatus(body.data?.status),
    displayText: body.data?.display_text ?? null,
    message: body.message ?? null,
  };
}

export interface VerifyResult {
  status: "pending" | "success" | "failed";
  chargeId: string | null;
  message: string | null;
}

/**
 * The fallback when the webhook is late or lost. Paystack's own advice:
 * if nothing has arrived within 180 seconds, ask.
 */
export async function verifyTransaction(
  credentials: PaystackCredentials,
  reference: string
): Promise<VerifyResult | null> {
  let response: Response;
  try {
    response = await fetch(`${API}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${credentials.secretKey}` },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch (err) {
    console.error("verifyTransaction: request failed", err);
    return null;
  }

  const body = (await response.json().catch(() => null)) as {
    status?: boolean;
    data?: { id?: number | string; status?: string; gateway_response?: string };
  } | null;

  if (!response.ok || !body?.status || !body.data) {
    return null;
  }

  const rawStatus = normaliseStatus(body.data.status);
  return {
    // verifyTransaction() has no OTP-collection UI of its own — it is
    // strictly a "did this settle yet" poll — so an otp_required charge
    // reads here the same as any other still-waiting one. The till only
    // ever learns about otp_required from the initial charge response
    // (or the webhook), never from this poll.
    status: rawStatus === "otp_required" ? "pending" : rawStatus,
    chargeId: body.data.id != null ? String(body.data.id) : null,
    message: body.data.gateway_response ?? null,
  };
}

/**
 * Paystack reports several in-flight states while a customer decides
 * (`pay_offline`, `send_otp`, `ongoing`, …). Everything that is not a
 * definite yes or a definite no is treated as "still waiting", because
 * the alternative — guessing — either completes an unpaid sale or throws
 * away one the customer did approve. `send_otp` is kept distinct from the
 * rest of that bucket, because unlike a plain approval prompt it never
 * resolves on its own — someone has to submit the code Paystack texted
 * the customer.
 */
function normaliseStatus(status: string | undefined): "pending" | "otp_required" | "success" | "failed" {
  if (status === "success") return "success";
  if (status === "failed" || status === "abandoned" || status === "reversed") return "failed";
  if (status === "send_otp") return "otp_required";
  return "pending";
}