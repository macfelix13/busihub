import type { PaystackCredentials } from "@/lib/paystack/client";

/**
 * Deliberately its own module, importing only the TYPE from
 * lib/paystack/client.ts (erased at compile time, so it pulls in none of
 * that file's runtime code). client.ts imports createServiceRoleClient
 * from lib/supabase/server.ts, which wraps itself in React's cache() —
 * fine inside a real Next.js server request, but cache() does not exist
 * outside one, which is exactly the environment a unit test runs in.
 * Keeping this pure and side-effect-free is what lets it be tested at all
 * without dragging in Supabase, cookies, or a request context.
 */

const API = "https://api.paystack.co";

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

/**
 * Confirms a shop's stored secret key actually authenticates with
 * Paystack — nothing is charged, and the key itself is never part of the
 * answer, only whether it worked.
 *
 * It asks Paystack to verify a transaction reference that cannot possibly
 * exist (a string namespaced to this feature, stamped with the current
 * time). Paystack answers that question two different ways depending on
 * whether the key is even recognised:
 *
 *   - A key Paystack does not recognise at all answers 401 "Invalid key",
 *     before it ever looks for the reference.
 *   - A key Paystack DOES recognise looks for the reference, does not
 *     find it (it was never real), and answers 404 — which is exactly the
 *     proof the key works, obtained without charging anything.
 *
 * Any other response (a 200 would mean this made-up reference somehow
 * already existed, which cannot happen) is reported as inconclusive
 * rather than guessed at either way.
 */
export async function testConnection(credentials: PaystackCredentials): Promise<ConnectionTestResult> {
  const reference = `busihub-connection-test-${Date.now()}`;

  let response: Response;
  try {
    response = await fetch(`${API}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${credentials.secretKey}` },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch (err) {
    console.error("testConnection: request failed", err);
    return { ok: false, message: "Couldn't reach Paystack. Check your connection and try again." };
  }

  if (response.status === 401) {
    return { ok: false, message: "Paystack rejected these credentials. Check the secret key and try again." };
  }

  if (response.status === 404) {
    return { ok: true, message: "Connected — Paystack accepted these credentials." };
  }

  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  console.error("testConnection: unexpected response", { status: response.status, message: body?.message });
  return { ok: false, message: "Paystack gave an unexpected response. Please try again in a moment." };
}