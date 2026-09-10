"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/**
 * A small, honest offline banner — not a promise that anything still
 * works. Phase 16 (Offline/PWA) only caches static assets and an offline
 * fallback page; there is no offline sale queue yet (that's Phase 17,
 * Synchronization, a separate and much bigger piece of work). So this
 * deliberately says "won't work until you reconnect", never anything
 * implying queued work will sync later — that would be a claim this app
 * cannot yet back up.
 *
 * Renders nothing while online; pinned to the bottom of the viewport
 * (rather than pushed inline into the header) so it never shifts any
 * page's layout by appearing or disappearing.
 */
export function ConnectionStatus() {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    // Both setOnline calls below run from event listener callbacks, never
    // as a bare statement in the effect body itself — the effect here
    // only ever adds/removes listeners, so react-hooks/set-state-in-effect
    // has nothing to flag (same reasoning as
    // components/notifications/notification-bell.tsx's refresh effect,
    // just via browser events instead of a timer).
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

  if (online) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-center text-sm font-medium text-brand-950"
    >
      <WifiOff className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      You&apos;re offline — most of Busihub won&apos;t work until you reconnect.
    </div>
  );
}