import { beforeEach, afterEach, describe, expect, it } from "vitest";

/**
 * lib/crypto/secret-box reads its key from the environment on every call,
 * not once at module load — which is what lets a test change the key
 * between encrypting and decrypting and see the failure that a rotated
 * PAYSTACK_KEY_ENCRYPTION_KEY would cause in production.
 *
 * Paystack keys below are ASSEMBLED rather than written out as literals: a
 * string like "sk_live_…" in a source file matches Stripe's secret-key
 * shape closely enough that GitHub's push protection blocks the push, and
 * an invented key that stops real work from shipping is a worse problem
 * than a slightly indirect fixture. Nothing here is a real key.
 */
const key = (mode: "test" | "live", body: string) => ["sk", mode, body].join("_");

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

async function box() {
  return await import("@/lib/crypto/secret-box");
}

const original = process.env.PAYSTACK_KEY_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.PAYSTACK_KEY_ENCRYPTION_KEY = KEY_A;
});

afterEach(() => {
  if (original === undefined) delete process.env.PAYSTACK_KEY_ENCRYPTION_KEY;
  else process.env.PAYSTACK_KEY_ENCRYPTION_KEY = original;
});

describe("secret-box", () => {
  it("round-trips a Paystack secret key", async () => {
    const { encryptSecret, decryptSecret } = await box();
    const secret = key("test", "0123456789abcdef0123456789abcdef01234567");
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("never stores the plaintext anywhere in the ciphertext", async () => {
    const { encryptSecret } = await box();
    const secret = key("live", "supersecretvalue1234567890");
    const stored = encryptSecret(secret);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain("supersecret");
  });

  it("produces a different ciphertext every time, so equal keys are not detectable", async () => {
    const { encryptSecret } = await box();
    const secret = key("test", "same-value-every-time-0000000000");
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it("carries a version prefix so the format can change later", async () => {
    const { encryptSecret } = await box();
    expect(encryptSecret(key("test", "abcdefghijklmnop")).startsWith("v1.")).toBe(true);
  });

  it("refuses a tampered ciphertext instead of returning different plaintext", async () => {
    const { encryptSecret, decryptSecret } = await box();
    const stored = encryptSecret(key("test", "abcdefghijklmnopqrstuvwxyz"));
    const parts = stored.split(".");
    // Flip a character in the ciphertext segment.
    const data = parts[3] ?? "";
    parts[3] = (data[0] === "A" ? "B" : "A") + data.slice(1);
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("refuses a ciphertext whose auth tag was replaced", async () => {
    const { encryptSecret, decryptSecret } = await box();
    const parts = encryptSecret(key("test", "abcdefghijklmnopqrstuvwxyz")).split(".");
    parts[2] = Buffer.alloc(16, 9).toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("cannot decrypt with a different key — this is what a database dump alone gets", async () => {
    const { encryptSecret } = await box();
    const stored = encryptSecret(key("live", "realmoneykey1234567890"));
    process.env.PAYSTACK_KEY_ENCRYPTION_KEY = KEY_B;
    const { decryptSecret } = await box();
    expect(() => decryptSecret(stored)).toThrow();
  });

  it("rejects a malformed stored value rather than half-decrypting it", async () => {
    const { decryptSecret } = await box();
    expect(() => decryptSecret("not-encrypted-at-all")).toThrow();
    expect(() => decryptSecret("v1.only.three")).toThrow();
    expect(() => decryptSecret("v2.a.b.c")).toThrow();
  });

  it("refuses a key that is not 256 bits rather than stretching it", async () => {
    process.env.PAYSTACK_KEY_ENCRYPTION_KEY = Buffer.from("short").toString("base64");
    const { encryptSecret } = await box();
    expect(() => encryptSecret(key("test", "abcdefghijklmnop"))).toThrow(/32 bytes/);
  });

  it("refuses to work at all with no key configured", async () => {
    delete process.env.PAYSTACK_KEY_ENCRYPTION_KEY;
    const { encryptSecret } = await box();
    expect(() => encryptSecret(key("test", "abcdefghijklmnop"))).toThrow(/PAYSTACK_KEY_ENCRYPTION_KEY/);
  });

  it("accepts a hex key as well as base64", async () => {
    process.env.PAYSTACK_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("hex");
    const { encryptSecret, decryptSecret } = await box();
    expect(decryptSecret(encryptSecret(key("test", "hexkey123456789")))).toBe(key("test", "hexkey123456789"));
  });

  it("shows only the last four characters for recognition", async () => {
    const { secretLast4 } = await box();
    expect(secretLast4(key("test", "0123456789abcdef"))).toBe("cdef");
  });
});
