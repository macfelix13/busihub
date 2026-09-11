"use client";

import { useEffect, useRef, useState } from "react";

// A tiny, always-present, unauthenticated same-origin file (already
// fetched elsewhere by the service worker's own precache list) — never
// touches Supabase, RLS, or a signed-in session, just "can this device
// actually reach our server right now." `cache: "no-store"` forces a
// real round trip every time instead of quietly answering from the
// service worker's own cache, which would defeat the entire point.
const PROBE_URL = "/manifest.webmanifest";
const PROBE_TIMEOUT_MS = 4000;
const CHECK_INTERVAL_MS = 5000;

async function probeReachable(): Promise<boolean> {
  // A browser that reports no network interface at all is trustworthy
  // in the negative direction — no point spending a request to confirm
  // what it's already certain of.
  if (typeof navigator !== "undefined" && !navigator.onLine) return false;
  if (typeof fetch === "undefined") return true;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      await fetch(PROBE_URL, { method: "HEAD", cache: "no-store", signal: controller.signal });
      return true;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return false;
  }
}

/**
 * Shared by components/ui/connection-status.tsx (the global banner) and
 * the till (which restricts payment methods to cash/credit and switches
 * to queuing sales locally while offline) — one listener implementation
 * instead of two copies that could quietly drift apart.
 *
 * This used to trust `navigator.onLine` alone (plus the `online`/
 * `offline` events, which fire off the same underlying flag). Two
 * rounds of real-device testing found that flag itself can't always be
 * trusted, for two different reasons: Chrome DevTools' network
 * emulation doesn't reliably fire the `online` event when switching
 * back to "No throttling" without a full reload (the flag itself was
 * still correct there — a bug fixed by re-reading it directly instead
 * of only listening for the event); then, on an actual phone with
 * confirmed working internet (other sites loading fine, in more than
 * one browser on the same device), the banner still stuck on "offline."
 * That points at `navigator.onLine` itself being stale at the OS level —
 * a documented real-world limitation on some Android network stacks,
 * where the flag can get stuck reporting no connection after a network
 * interface flaps, independent of which browser reads it.
 *
 * So this now verifies the thing that actually matters — can this page
 * reach the server at all — with a real fetch of a tiny static file,
 * rather than trusting a flag that's turned out to be wrong twice.
 * `navigator.onLine` is still checked first as a fast, free short-
 * circuit for the confident "definitely no network interface" case; it
 * just no longer gets the final word on "yes, we're online."
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  // Guards against a slow probe from an earlier tick resolving after a
  // faster, more recent one — the interval keeps firing every 5s
  // regardless of how long any one probe takes, so without this an old
  // result could land after a newer one and briefly flip the state
  // backwards.
  const requestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    function check() {
      const requestId = ++requestIdRef.current;
      probeReachable().then((reachable) => {
        if (!cancelled && requestId === requestIdRef.current) setOnline(reachable);
      });
    }

    function goOffline() {
      // A real, negative signal worth acting on immediately rather than
      // waiting up to CHECK_INTERVAL_MS for the next probe.
      requestIdRef.current += 1;
      setOnline(false);
    }

    window.addEventListener("online", check);
    window.addEventListener("offline", goOffline);
    // Scheduled rather than called bare (`check()`) here, matching
    // notification-bell.tsx's own reasoning: react-hooks/set-state-in-effect
    // flags a function invoked directly from an effect body if its call
    // graph reaches a setState anywhere — including inside a `.then()`,
    // not just a bare synchronous call — so this goes through setTimeout
    // the same way that file's refresh() does.
    const initial = window.setTimeout(check, 0);
    const interval = window.setInterval(check, CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.removeEventListener("online", check);
      window.removeEventListener("offline", goOffline);
      window.clearInterval(interval);
    };
  }, []);

  return online;
}