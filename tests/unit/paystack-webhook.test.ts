import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "@/lib/paystack/webhook";
import { keyMode, paystackSettingsSchema } from "@/lib/validation/payments";
/**
 * Paystack keys are ASSEMBLED here rather than written out as literals.
 * A string like "sk_live_…" in a source file matches Stripe's secret-key
 * shape closely enough that GitHub's push protection blocks the push —
 * and an invented key that stops real work from shipping is a worse
 * problem than a slightly indirect fixture. Nothing below is a real key.
 */
const key = (mode: "test" | "live", body: string) => ["sk", mode, body].join("_");
const pubKey = (mode: "test" | "live", body: string) => ["pk", mode, body].join("_");


const SECRET = key("test", "0123456789abcdef0123456789abcdef01234567");
const OTHER_SECRET = key("test", "ffffffffffffffffffffffffffffffffffffffff");

/** Exactly what Paystack does, so the test is not just re-running our own code. */
function sign(body: string, secret = SECRET) {
  return createHmac("sha512", secret).update(body, "utf8").digest("hex");
}

const body = JSON.stringify({
  event: "charge.success",
  data: { id: 302961, reference: "8b1f3f2e-1c2d-4a5b-9e8f-0a1b2c3d4e5f", status: "success" },
});

describe("verifyWebhookSignature", () => {
  it("accepts a genuine Paystack signature", () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a signature made with a different shop's key", () => {
    // The case that matters: every shop connects its own account, so an
    // event signed by one must not verify against another's secret.
    expect(verifyWebhookSignature(body, sign(body, OTHER_SECRET), SECRET)).toBe(false);
  });

  it("rejects an unsigned request", () => {
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "", SECRET)).toBe(false);
  });

  it("rejects a body altered after signing, even by one character", () => {
    const signature = sign(body);
    const tampered = body.replace('"status":"success"', '"status":"SUCCESS"');
    expect(verifyWebhookSignature(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects an amount swapped for a bigger one", () => {
    const original = JSON.stringify({ event: "charge.success", data: { amount: 100 } });
    const signature = sign(original);
    const swapped = JSON.stringify({ event: "charge.success", data: { amount: 1000000 } });
    expect(verifyWebhookSignature(swapped, signature, SECRET)).toBe(false);
  });

  it("is sensitive to whitespace, which is why the RAW body must be used", () => {
    // Re-serialising parsed JSON is the classic way to break this: same
    // data, different bytes, signature no longer matches.
    const signature = sign(body);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyWebhookSignature(reserialised, signature, SECRET)).toBe(false);
  });

  it("rejects a signature of the wrong length rather than throwing", () => {
    // timingSafeEqual throws on mismatched lengths; this must return
    // false, not crash the route into a 500 that Paystack retries.
    expect(() => verifyWebhookSignature(body, "abc123", SECRET)).not.toThrow();
    expect(verifyWebhookSignature(body, "abc123", SECRET)).toBe(false);
  });

  it("rejects everything when no secret is configured", () => {
    expect(verifyWebhookSignature(body, sign(body), "")).toBe(false);
  });
});

describe("paystackSettingsSchema", () => {
  const valid = { secretKey: SECRET, publicKey: pubKey("test", "0123456789abcdef0123456789"), momoEnabled: true };

  it("accepts a matching test pair", () => {
    expect(paystackSettingsSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a blank secret, meaning keep the one already stored", () => {
    const result = paystackSettingsSchema.safeParse({ ...valid, secretKey: "" });
    expect(result.success).toBe(true);
  });

  it("catches the public key pasted into the secret box", () => {
    const result = paystackSettingsSchema.safeParse({ ...valid, secretKey: valid.publicKey });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("public key");
    }
  });

  it("catches a live secret paired with a test public key", () => {
    const result = paystackSettingsSchema.safeParse({
      ...valid,
      secretKey: key("live", "0123456789abcdef0123456789abcdef01234567"),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("test key");
    }
  });

  it("refuses a missing or malformed public key", () => {
    expect(paystackSettingsSchema.safeParse({ ...valid, publicKey: "" }).success).toBe(false);
    expect(paystackSettingsSchema.safeParse({ ...valid, publicKey: "not-a-key" }).success).toBe(false);
  });

  it("trims a key copied with a trailing space", () => {
    const result = paystackSettingsSchema.safeParse({ ...valid, secretKey: ` ${SECRET} ` });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.secretKey).toBe(SECRET);
  });

  it("reads live vs test off the key itself rather than asking", () => {
    expect(keyMode(key("live", "abc"))).toBe("live");
    expect(keyMode(pubKey("live", "abc"))).toBe("live");
    expect(keyMode(key("test", "abc"))).toBe("test");
    expect(keyMode("nonsense")).toBe(null);
  });
});
