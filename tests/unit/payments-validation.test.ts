import { describe, expect, it } from "vitest";
import { paystackSettingsSchema, keyMode, momoNetworkLabel } from "@/lib/validation/payments";

/**
 * The one save on this page with a real financial consequence — pasting a
 * LIVE secret key — needs an explicit "yes, I mean it" (confirmLive),
 * checked here alongside the existing key-shape rules it sits next to.
 */

const TEST_SECRET = "sk_test_abc123def456ghi789";
const TEST_PUBLIC = "pk_test_abc123def456ghi789";
const LIVE_SECRET = "sk_live_abc123def456ghi789";
const LIVE_PUBLIC = "pk_live_abc123def456ghi789";

describe("paystackSettingsSchema — live-mode confirmation", () => {
  it("accepts a test key with no confirmation needed", () => {
    const result = paystackSettingsSchema.safeParse({
      secretKey: TEST_SECRET,
      publicKey: TEST_PUBLIC,
      momoEnabled: true,
      confirmLive: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unconfirmed live key", () => {
    const result = paystackSettingsSchema.safeParse({
      secretKey: LIVE_SECRET,
      publicKey: LIVE_PUBLIC,
      momoEnabled: true,
      confirmLive: false,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "confirmLive");
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/live/i);
    }
  });

  it("accepts a confirmed live key", () => {
    const result = paystackSettingsSchema.safeParse({
      secretKey: LIVE_SECRET,
      publicKey: LIVE_PUBLIC,
      momoEnabled: true,
      confirmLive: true,
    });
    expect(result.success).toBe(true);
  });

  it("does not ask for confirmation when no new secret key is being saved", () => {
    // Leaving the secret box empty means "keep the key already stored" —
    // toggling momoEnabled on an already-connected, already-live shop
    // must not suddenly demand this checkbox again.
    const result = paystackSettingsSchema.safeParse({
      secretKey: "",
      publicKey: LIVE_PUBLIC,
      momoEnabled: false,
      confirmLive: false,
    });
    expect(result.success).toBe(true);
  });

  it("still catches a mismatched test/live pair before ever reaching the live-confirmation check", () => {
    const result = paystackSettingsSchema.safeParse({
      secretKey: LIVE_SECRET,
      publicKey: TEST_PUBLIC,
      momoEnabled: true,
      confirmLive: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("secretKey");
      expect(paths).not.toContain("confirmLive");
    }
  });

  it("defaults confirmLive to false when the field is omitted entirely", () => {
    const result = paystackSettingsSchema.safeParse({
      secretKey: LIVE_SECRET,
      publicKey: LIVE_PUBLIC,
      momoEnabled: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("keyMode", () => {
  it("reads live and test off either key's prefix", () => {
    expect(keyMode(LIVE_SECRET)).toBe("live");
    expect(keyMode(LIVE_PUBLIC)).toBe("live");
    expect(keyMode(TEST_SECRET)).toBe("test");
    expect(keyMode(TEST_PUBLIC)).toBe("test");
    expect(keyMode("not-a-paystack-key")).toBe(null);
  });
});

describe("momoNetworkLabel", () => {
  it("labels a known network and falls back to the raw value for an unknown one", () => {
    expect(momoNetworkLabel("mtn")).toBe("MTN MoMo");
    expect(momoNetworkLabel("something-else")).toBe("something-else");
  });
});