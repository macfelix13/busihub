import "server-only";
import { turnstileSecretKey } from "@/lib/env";

/**
 * Cloudflare Turnstile verification (2026-09 20-point audit, gap #12).
 * Pairs with components/auth/turnstile-widget.tsx — see that file's
 * comment for the client side, and turnstileSecretKey()'s own comment in
 * lib/env.ts for why this is deliberately inert until a real Cloudflare
 * account is configured.
 *
 * Called from the three PUBLIC, unauthenticated forms that can otherwise
 * be hit by a script with no account at all: register, login, and
 * reset-password (app/(auth)/*\/actions.ts). The till's own "switch
 * user" re-login (app/(app)/till/actions.ts) is deliberately NOT covered
 * — it requires an existing signed-in session behind the (app) layout
 * already, so it isn't reachable by an anonymous bot the way these three
 * are.
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface TurnstileVerifyResponse {
  success?: boolean;
  "error-codes"?: string[];
}

/**
 * Verifies a Cloudflare Turnstile response token before trusting a
 * public form submission. `token` is whatever the caller read from
 * formData.get("cf-turnstile-response") — the hidden field the widget
 * injects itself once solved (see the widget component for why nothing
 * else has to wire that field up by hand).
 *
 * Returns true (i.e. skips enforcement) when:
 *   - TURNSTILE_SECRET_KEY isn't set yet — not configured, not a
 *     rejection; see turnstileSecretKey()'s own comment.
 *   - Cloudflare's own siteverify endpoint couldn't be reached at all
 *     (network error, timeout). This mirrors lib/auth/rate-limit.ts's
 *     checkRateLimit(): a Cloudflare outage must never itself become a
 *     way to lock every business out of signing in, because this is
 *     defense-in-depth stacked on top of real password auth and rate
 *     limiting, not the actual security boundary underneath them.
 *
 * Returns false — reject the submission — only once Cloudflare has
 * actually been asked and said the token is missing, expired, reused, or
 * otherwise invalid.
 */
export async function verifyTurnstileToken(token: FormDataEntryValue | null): Promise<boolean> {
  const secretKey = turnstileSecretKey();
  if (!secretKey) {
    return true;
  }

  if (!token || typeof token !== "string") {
    // A configured secret key with no token at all means either the
    // widget didn't render (no site key set — a config mismatch worth
    // knowing about) or client-side JS/the widget failed. Either way,
    // once enforcement is actually on, no token means reject.
    console.error("verifyTurnstileToken: no token present on a request while enforcement is on");
    return false;
  }

  let response: Response;
  try {
    response = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: secretKey, response: token }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("verifyTurnstileToken: request to Cloudflare failed", err);
    return true;
  }

  const body = (await response.json().catch(() => null)) as TurnstileVerifyResponse | null;
  if (!body?.success) {
    console.error("verifyTurnstileToken: challenge rejected", body?.["error-codes"]);
    return false;
  }

  return true;
}