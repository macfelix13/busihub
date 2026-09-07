import { afterEach, describe, expect, it, vi } from "vitest";
import { testConnection } from "@/lib/paystack/connection-test";
import type { PaystackCredentials } from "@/lib/paystack/client";

/**
 * testConnection() tells a real key from a wrong one by the HTTP status
 * Paystack answers a made-up transaction reference with — 401 before it
 * even looks (key unrecognised) vs 404 after it looked and found nothing
 * (key recognised, reference never existed). These tests stub global
 * fetch to stand in for both answers, plus a dropped request and an
 * unexpected status, without making a real network call.
 */

const credentials: PaystackCredentials = {
  secretKey: "sk_test_abc123def456",
  publicKey: "pk_test_abc123def456",
  isLive: false,
  momoEnabled: true,
};

function fakeResponse(status: number, message: string) {
  return { status, json: async () => ({ status: false, message }) } as unknown as Response;
}

describe("testConnection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports success when Paystack answers 404 — the key is recognised, the made-up reference is not", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(404, "Transaction reference not found")));
    const result = await testConnection(credentials);
    expect(result.ok).toBe(true);
  });

  it("reports failure when Paystack answers 401 — the key itself is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(401, "Invalid key")));
    const result = await testConnection(credentials);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected/i);
  });

  it("reports failure, not success, when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const result = await testConnection(credentials);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/reach paystack/i);
  });

  it("treats an unexpected status as inconclusive rather than guessing success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(500, "Something else")));
    const result = await testConnection(credentials);
    expect(result.ok).toBe(false);
  });

  it("never includes the secret key in its returned message, on any path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(401, "Invalid key")));
    const result = await testConnection(credentials);
    expect(result.message).not.toContain(credentials.secretKey);
  });

  it("sends the secret key as a bearer token, never the public key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(404, "Transaction reference not found"));
    vi.stubGlobal("fetch", fetchMock);
    await testConnection(credentials);
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe(`Bearer ${credentials.secretKey}`);
  });
});