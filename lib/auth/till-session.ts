import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Who is standing at the till.
 *
 * The device stays signed in to Supabase as one account all day; the PIN
 * says which colleague is actually serving, so each sale records a real
 * person. That identity therefore has to survive between requests, and it
 * must not be forgeable — otherwise a cashier could simply claim to be the
 * manager, which would make the whole PIN exercise decorative.
 *
 * So it is a signed cookie, not a plain one: HMAC-SHA256 over the payload
 * with PIN_SESSION_SECRET. The server re-derives the signature on every
 * read and ignores anything that does not match. The cookie is httpOnly
 * (no script can read it), sameSite=lax, and secure outside development.
 *
 * This is deliberately NOT an authentication token — the Supabase session
 * is still what authorises everything, and every Server Action re-checks
 * permissions server-side. A forged cookie could at worst mis-attribute a
 * sale to a colleague, which is exactly why it is signed.
 */

const COOKIE_NAME = "busihub_till";
/** A till shift, not a login. Long enough for a day behind the counter. */
const MAX_AGE_SECONDS = 12 * 60 * 60;

interface TillSessionPayload {
  /** profiles.id of the cashier at the counter. */
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

export async function readTillSession(): Promise<{ cashierId: string; name: string } | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;

  const payload = decode(raw);
  if (!payload) return null;

  return { cashierId: payload.cashierId, name: payload.name };
}

export async function endTillSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
