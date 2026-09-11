"use client";

import { useEffect, useState } from "react";

/**
 * Shared by components/ui/connection-status.tsx (the global banner) and
 * the till (which restricts payment methods to cash/credit and switches
 * to queuing sales locally while offline) — one listener implementation
 * instead of two copies that could quietly drift apart.
 *
 * Confirmed during real-browser testing: switching Chrome DevTools'
 * Network conditions dropdown from "Offline" back to "No throttling"
 * does not reliably fire a real `online` event — the banner stayed
 * stuck saying "You're offline" with the dropdown clearly back to "No
 * throttling." `navigator.onLine` itself still flips back correctly
 * even when that event doesn't fire, so a periodic re-check (on top of
 * the event listeners, not instead of them — a real device regaining a
 * genuine connection still fires them reliably, and this only adds a
 * few seconds of latency in the case where it doesn't) catches what the
 * event misses.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    function goOnline() {
      setOnline(true);
    }
    function goOffline() {
      setOnline(false);
    }
    function resync() {
      setOnline(navigator.onLine);
    }
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    const interval = window.setInterval(resync, 3000);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.clearInterval(interval);
    };
  }, []);

  return online;
}