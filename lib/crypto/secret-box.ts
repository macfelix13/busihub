import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption for the one class of value this app stores that can move
 * real money: a shop's own Paystack secret key.
 *
 * AES-256-GCM. GCM rather than CBC because it authenticates as well as
 * encrypts — a tampered ciphertext fails to decrypt instead of quietly
 * producing different plaintext. The key comes from the server's
 * environment and is never written to the database, so a dump of
 * business_payment_settings on its own decrypts to nothing.
 *
 * Format: v1.<iv>.<authTag>.<ciphertext>, all base64url. The version
 * prefix is there so a future algorithm change can be rolled out without
 * guessing what old rows contain.
 */

const VERSION = "v1";
const IV_BYTES = 12; // 96 bits, the size GCM is specified for.

function key(): Buffer {
  const raw = process.env.PAYSTACK_KEY_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "PAYSTACK_KEY_ENCRYPTION_KEY is not set — a Paystack secret key cannot be stored or read without it."
    );
  }
  // Accept base64 or hex, and require a real 256-bit key either way. A
  // short passphrase silently stretched to 32 bytes would look like it
  // worked while providing a fraction of the strength.
  const decoded = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      "PAYSTACK_KEY_ENCRYPTION_KEY must be 32 bytes (256 bits) — generate one with: openssl rand -base64 32"
    );
  }
  return decoded;
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) {
    throw new Error("Nothing to encrypt.");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(".");
  const [version, ivPart, tagPart, dataPart] = parts;
  if (parts.length !== 4 || version !== VERSION || !ivPart || !tagPart || !dataPart) {
    throw new Error("Stored secret is not in the expected format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  // Throws if the ciphertext or tag was altered — which is the point.
  return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
}

/** The last four characters, so a person can recognise which key is installed. */
export function secretLast4(plaintext: string): string {
  return plaintext.slice(-4);
}
