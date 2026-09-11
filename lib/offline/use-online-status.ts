"use client";

import { useEffect, useState } from "react";

/**
 * Shared by components/ui/connection-status.tsx (the global banner) and
 * the till (which restricts payment methods to cash/credit and switches
 * to queuing sales locally while offline) — one listener implementation
 * instead of two copies that could quietly drift apart.
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
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}