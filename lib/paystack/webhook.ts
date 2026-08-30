import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature verification, deliberately in its own module with no
 * Supabase or Next imports: it is pure, it is the single thing standing
 * between a stranger and "this sale is paid for", and it should be
 * testable without a request context.
 */

/**
 * Verifies a webhook came from Paystack: HMAC-SHA512 of the RAW request
 * body under the shop's own secret key.
 *
 * It must be the raw body, byte for byte. Re-serialising parsed JSON
 * produces a different string for the same payload (key order, number
 * formatting, whitespace), so the signature then never matches — which
 * looks exactly like an attack and is in fact a bug in the reader.
 */
export function verifyWebhookSignature(rawBody: string, signature: string | null, secretKey: string): boolean {
  if (!signature || !secretKey) return false;

  const expected = createHmac("sha512", secretKey).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");

  // timingSafeEqual throws on a length mismatch, so that is checked
  // first — and a wrong length is a wrong signature regardless.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
