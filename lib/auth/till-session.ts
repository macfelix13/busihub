import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Whether the SIGNED-IN account has unlocked the till with their own PIN
 * yet this shift.
 *
 * Before 0039, this cookie could name a DIFFERENT colleague than whoever
 * was actually logged into the browser — the till was built for a device
 * that stayed signed in to Supabase as one account all day, while
 * different people PIN-verified as themselves in turn. That let anyone
 * who knew (or guessed) a colleague's PIN attribute a sale to that
 * colleague without them being the one who actually rang it up.
 *
 * 0039 closes that at the database layer (verify_profile_pin() only ever
 * checks the CALLER's own PIN now; create_sale()/create_refund() always
 * record auth.uid(), never a client-supplied cashier id), and this file
 * follows suit: `cashierId` here is now always the SAME account as
 * whoever is logged in — readTillSession() takes the current auth.uid()
 * and refuses to return a session that doesn't match it, so switching to
 * a different Supabase login (the till's own "switch user" step, a real
 * password sign-in — see app/(app)/till/actions.ts) can never inherit a
 * stale unlock left by the previous person.
 *
 * It is still a signed cookie, not a plain one: HMAC-SHA256 over the
 * payload with PIN_SESSION_SECRET. The server re-derives the signature on
 * every read and ignores anything that does not match. The cookie is
 * httpOnly (no script can read it), sameSite=lax, and secure outside
 * development.
 *
 * This is deliberately NOT an authentication token — the Supabase session
 * is still what authorises everything, and every Server Action re-checks
 * permissions server-side. This cookie only ever gates whether the till's
 * selling screen renders instead of the PIN prompt; a forged or replayed
 * one could at worst skip that lock screen for an account that is already
 * genuinely logged in — it can no longer attribute anything to anyone
 * else, which is what it was actually guarding against before.
 */

const COOKIE_NAME = "busihub_till";
/** A till shift, not a login. Long enough for a day behind the counter. */
const MAX_AGE_SECONDS = 12 * 60 * 60;

interface TillSessionPayload {
  /** Always the account that verified its own PIN — see header. */
  cashierId: string;
  /** Display name, cached so the header needn't re-query on every render. */
  name: string;
  /** Unix seconds. Checked on read; the cookie's own maxAge can be tampered with, this cannot. */
  expiresAt: number;
}

function secret(): string {
  const value = process.env.PIN_SESSION_SECRET;
  if (!value || value.length < 16) {
    // Failing loudly beats signing with a weak or absent key and
    // pretending the result means something.
    throw new Error("PIN_SESSION_SECRET is not set (or is too short) — the till session cannot be signed.");
  }
  return value;
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself leak
  // length; compare lengths first and always run the constant-time check.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function encode(payload: TillSessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode(value: string): TillSessionPayload | null {
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;

  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);

  if (!safeEquals(signature, sign(body))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TillSessionPayload;
    if (typeof payload.cashierId !== "string" || typeof payload.expiresAt !== "number") return null;
    if (payload.expiresAt * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * @param cashierId Must be the CALLER's own auth.uid() — see the header.
 *   Callers pass it explicitly (rather than this function reading the
 *   session itself) so a mistake here is visible at the call site instead
 *   of hidden behind another layer of "trust me".
 */
export async function startTillSession(cashierId: string, name: string): Promise<void> {
  const payload: TillSessionPayload = {
    cashierId,
    name,
    expiresAt: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
  };

  const store = await cookies();
  store.set(COOKIE_NAME, encode(payload), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

/**
 * @param currentUserId The signed-in account's own auth.uid(). A session
 *   whose `cashierId` does not match it is treated as no session at all —
 *   this is what stops an unlock from one login surviving a "switch user"
 *   to a different one, even if the switch somehow skipped calling
 *   endTillSession() (belt and suspenders: the switch action does call it
 *   too).
 */
export async function readTillSession(currentUserId: string): Promise<{ cashierId: string; name: string } | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;

  const payload = decode(raw);
  if (!payload) return null;
  if (payload.cashierId !== currentUserId) return null;

  return { cashierId: payload.cashierId, name: payload.name };
}

export async function endTillSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}