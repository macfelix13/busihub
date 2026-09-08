import { describe, expect, it } from "vitest";
import { paystackSettingsSchema, keyMode, momoNetworkLabel, guessMomoNetwork } from "@/lib/validation/payments";

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

/**
 * A wrong network is the most likely reason a real mobile money charge
 * gets declined outright (production incident, 2026-09) — the till's
 * network dropdown used to default to MTN with no connection to the
 * number actually typed in. This is a best-effort DEFAULT, never a
 * guarantee (Mobile Number Portability means a prefix can be wrong), so
 * every prefix here is checked against a known, confidently-assigned
 * block, and anything uncertain (bare 025, 023/028/029, malformed
 * numbers) must come back null rather than a guess dressed up as fact.
 */
describe("guessMomoNetwork", () => {
  it("recognises MTN prefixes", () => {
    expect(guessMomoNetwork("0244123456")).toBe("mtn");
    expect(guessMomoNetwork("0544123456")).toBe("mtn");
    expect(guessMomoNetwork("0534123456")).toBe("mtn");
    expect(guessMomoNetwork("0554123456")).toBe("mtn");
    expect(guessMomoNetwork("0594123456")).toBe("mtn");
  });

  it("recognises the confirmed MTN sub-blocks of 025, but not the rest of 025", () => {
    expect(guessMomoNetwork("0256123456")).toBe("mtn");
    expect(guessMomoNetwork("0257123456")).toBe("mtn");
    expect(guessMomoNetwork("0251123456")).toBe(null);
  });

  it("recognises Telecel (formerly Vodafone) prefixes", () => {
    expect(guessMomoNetwork("0204123456")).toBe("vod");
    expect(guessMomoNetwork("0504123456")).toBe("vod");
  });

  it("recognises AirtelTigo prefixes", () => {
    expect(guessMomoNetwork("0264123456")).toBe("atl");
    expect(guessMomoNetwork("0274123456")).toBe("atl");
    expect(guessMomoNetwork("0564123456")).toBe("atl");
    expect(guessMomoNetwork("0574123456")).toBe("atl");
  });

  it("returns null for prefixes with no confident public assignment, rather than guessing", () => {
    expect(guessMomoNetwork("0234123456")).toBe(null); // Glo
    expect(guessMomoNetwork("0284123456")).toBe(null);
    expect(guessMomoNetwork("0294123456")).toBe(null);
  });

  it("returns null for anything that isn't a well-formed local number", () => {
    expect(guessMomoNetwork("")).toBe(null);
    expect(guessMomoNetwork("123")).toBe(null);
    expect(guessMomoNetwork("02441234567")).toBe(null); // 11 digits
    expect(guessMomoNetwork("+233244123456")).toBe(null); // expects already-normalised local form
  });
});