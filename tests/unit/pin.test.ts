import { describe, expect, it } from "vitest";
import { assertValidPinFormat, hashPin, InvalidPinFormatError, verifyPin } from "@/lib/auth/pin";

describe("PIN format validation", () => {
  it("accepts 4-6 digit PINs", () => {
    expect(() => assertValidPinFormat("1234")).not.toThrow();
    expect(() => assertValidPinFormat("123456")).not.toThrow();
  });

  it("rejects non-numeric, too-short, or too-long PINs", () => {
    expect(() => assertValidPinFormat("12a4")).toThrow(InvalidPinFormatError);
    expect(() => assertValidPinFormat("123")).toThrow(InvalidPinFormatError);
    expect(() => assertValidPinFormat("1234567")).toThrow(InvalidPinFormatError);
    expect(() => assertValidPinFormat("")).toThrow(InvalidPinFormatError);
  });
});

describe("hashPin / verifyPin", () => {
  it("produces a hash that verifies against the original PIN", async () => {
    const hash = await hashPin("4821");
    expect(hash).not.toBe("4821");
    await expect(verifyPin("4821", hash)).resolves.toBe(true);
  });

  it("rejects an incorrect PIN against a valid hash", async () => {
    const hash = await hashPin("4821");
    await expect(verifyPin("9999", hash)).resolves.toBe(false);
  });

  it("never stores the plaintext PIN as the hash", async () => {
    const hash = await hashPin("123456");
    expect(hash).not.toContain("123456");
  });

  it("rejects hashing an invalid PIN format", async () => {
    await expect(hashPin("abc")).rejects.toThrow(InvalidPinFormatError);
  });
});
