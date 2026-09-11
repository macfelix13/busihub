"use client";

import { useEffect, useState } from "react";

// A tiny, always-present, unauthenticated same-origin file — never
// touches Supabase, RLS, or a signed-in session, just "can this device
// actually reach our server right now." `cache: "no-store"` asks not to
// answer from the browser's own HTTP cache; it doesn't touch the
// service worker's SEPARATE Cache Storage, but that's fine here — the
// service worker only intercepts plain GETs (see public/sw.js), and
// this probe deliberately uses HEAD so it always reaches the network.
const PROBE_URL = "/manifest.webmanifest";
const PROBE_TIMEOUT_MS = 4000;
const CHECK_INTERVAL_MS = 5000;

async function probeOnline(): Promise<boolean> {
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
 * This has been wrong twice already trying to answer "are we online"
 * from a single flag. First `navigator.onLine` alone: Chrome DevTools'
 * network emulation doesn't reliably fire the `online` event when
 * switching back to "No throttling" without a reload. Then, on an
 * actual phone with confirmed working internet (other sites loading
 * fine, in more than one browser on the same device), the banner still
 * stuck on "offline" — `navigator.onLine` itself can get stuck stale at
 * the OS level on some Android devices, independent of which browser
 * reads it. Polling that same flag more often (the first fix) couldn't
 * help, since it was still trusting a value that was itself wrong.
 *
 * Live debugging then found a THIRD failure mode in the very fix meant
 * to solve the second one: a real network probe was added, but with a
 * "the newest check always wins" rule — so if a slow or transiently-
 * aborted probe (harmless page churn during hydration was observed
 * cancelling in-flight requests, for instance) happened to be the most
 * recent one to resolve, its failure could overwrite a perfectly good
 * "yes, we're online" result an earlier probe had just confirmed.
 * Confirmed directly: a real successful reachability check (HTTP 200)
 * still left the banner reading "offline" a full second and a half
 * later, because a second, less lucky check finished after it and won.
 *
 * The fix is to stop treating "online" and "offline" symmetrically. A
 * probe can only ever move this towards TRUE — a failed or aborted one
 * changes nothing, so there is no "newest wins" race left to lose
 * against. The one thing allowed to mark this FALSE is the browser's
 * own `offline` event, which — unlike the *recovery* side of this —
 * has not been observed to misfire: everything that went wrong here was
 * about the flag failing to come back, never about it going stale while
 * actually still connected. `navigator.onLine` still seeds the very
 * first render (so a page that starts genuinely offline doesn't have to
 * wait for a probe to say so), but never overrides a later success.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    let cancelled = false;

    function goOffline() {
      setOnline(false);
    }

    // Only ever raises `online` to true on a confirmed success — never
    // lowers it. A failed/timed-out/aborted probe is simply inconclusive
    // (could be a real outage, could be unrelated churn) and is treated
    // as "no news," not as evidence of being offline.
    function tryGoOnline() {
      probeOnline().then((reachable) => {
        if (!cancelled && reachable) setOnline(true);
      });
    }

    window.addEventListener("online", tryGoOnline);
    window.addEventListener("offline", goOffline);
    // Scheduled rather than called bare (`tryGoOnline()`) here, matching
    // notification-bell.tsx's own reasoning: react-hooks/set-state-in-effect
    // flags a function invoked directly from an effect body if its call
    // graph reaches a setState anywhere — including inside a `.then()`,
    // not just a bare synchronous call — so this goes through setTimeout
    // the same way that file's refresh() does.
    const initial = window.setTimeout(tryGoOnline, 0);
    const interval = window.setInterval(tryGoOnline, CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener("online", tryGoOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}