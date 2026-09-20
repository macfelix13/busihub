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
 * Only the plan-sync half (creating/updating a Paystack "Plan" object,
 * called from Super Admin's /admin/plans) lives here so far — see
 * migration 0060's own header for why this ships in two deliveries. The
 * checkout-initialize/cancel-subscription functions this module will
 * also need are deliberately not written yet: there is no page that
 * would call them, and writing an untested, unused integration against
 * an external API ahead of the feature that exercises it is exactly the
 * kind of "looks done, isn't real" work the project brief warns against.
 *
 * IMPORTANT, stated plainly rather than implied: everything below is
 * written to Paystack's own documented REST contract for the Plan API,
 * but has NOT been exercised against a real Paystack account from this
 * environment (no live credentials are reachable here). It must be
 * run once against real Paystack test-mode keys — create a plan, edit
 * it, confirm what comes back matches what this code expects — before
 * it is trusted with a live key.
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