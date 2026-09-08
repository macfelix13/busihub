import "server-only";
import bcrypt from "bcryptjs";

/**
 * Cashier PIN hashing (Section 6, Section 29). A PIN is short (4-6
 * digits) by design — it's a fast unlock for a device that's already
 * behind a real Supabase Auth session, not a standalone credential — so
 * it MUST be rate-limited in addition to being hashed. Hashing alone
 * does not make a 4-digit PIN resistant to online brute force.
 *
 * PIN entry's own lockout is DB-enforced directly on the profile
 * (pin_failed_attempts/pin_locked_until below, checked inside
 * verify_profile_pin(), migration 0039) rather than going through
 * lib/auth/rate-limit.ts — that module instead covers the real Supabase
 * Auth password sign-ins a PIN sits behind (login, till switch-user) and
 * password-reset requests, which had no lockout at all before migration
 * 0048 / the 2026-09 security review.
 */

const BCRYPT_COST_FACTOR = 10;
const PIN_PATTERN = /^\d{4,6}$/;

export class InvalidPinFormatError extends Error {
  constructor() {
    super("PIN must be 4 to 6 digits.");
    this.name = "InvalidPinFormatError";
  }
}

export function assertValidPinFormat(pin: string): void {
  if (!PIN_PATTERN.test(pin)) {
    throw new InvalidPinFormatError();
  }
}

/** Hash a plaintext PIN. Never store or log the plaintext value. */
export async function hashPin(pin: string): Promise<string> {
  assertValidPinFormat(pin);
  return bcrypt.hash(pin, BCRYPT_COST_FACTOR);
}

/** Compare a plaintext PIN against a stored hash. */
export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  if (!PIN_PATTERN.test(pin)) return false;
  return bcrypt.compare(pin, hash);
}

export const PIN_LOCKOUT_THRESHOLD = 5;
export const PIN_LOCKOUT_DURATION_MINUTES = 15;