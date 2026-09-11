"use client";

import { RefreshCw, WifiOff } from "lucide-react";
import { useOnlineStatus } from "@/lib/offline/use-online-status";
import { usePendingSync } from "@/lib/offline/use-pending-sync";

/**
 * An honest status banner — never a promise that more works than
 * actually does.
 *
 * Phase 16 (Offline/PWA) only cached static assets and an offline
 * fallback page; there was no offline sale queue, so this used to say
 * simply "won't work until you reconnect" and render nothing at all
 * while online. Phase 17's client half (lib/offline/*) changed that for
 * exactly one thing — a cash or on-account sale rung up at the till — so
 * this now also has something to say once there IS a queue: while
 * offline, how many sales are waiting on this device; while online
 * again, whether they're syncing, done, or stuck. It still says nothing
 * implying anything OTHER than a till sale works offline, because
 * nothing else does.
 *
 * Renders nothing only when online with an empty queue — pinned to the
 * bottom of the viewport (rather than pushed inline into the header) so
 * it never shifts any page's layout by appearing or disappearing.
 */
export function ConnectionStatus() {
  const online = useOnlineStatus();
  const { count, failedCount, syncing, networkError, syncNow } = usePendingSync();

  if (online && count === 0) return null;

  return (
    <div
      role="status"
      className={`fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center justify-center gap-2 px-4 py-2 text-center text-sm font-medium text-brand-950 ${
        online ? "bg-lime-400" : "bg-amber-500"
      }`}
    >
      {online ? (
        <>
          <RefreshCw className={`h-4 w-4 flex-shrink-0 ${syncing ? "animate-spin" : ""}`} aria-hidden="true" />
          <span>
            {networkError
              ? `Couldn't reach the server to sync ${count} queued sale${count === 1 ? "" : "s"}.`
              : failedCount > 0
                ? `${failedCount} queued sale${failedCount === 1 ? "" : "s"} couldn't sync yet.`
                : syncing
                  ? `Syncing ${count} queued sale${count === 1 ? "" : "s"}…`
                  : `${count} queued sale${count === 1 ? "" : "s"} waiting to sync.`}
          </span>
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing}
            className="underline underline-offset-2 disabled:no-underline disabled:opacity-60"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </>
      ) : (
        <>
          <WifiOff className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span>
            {count > 0
              ? `You're offline — ${count} sale${count === 1 ? "" : "s"} saved on this device, will sync when you reconnect.`
              : "You're offline — most of Busihub won't work until you reconnect."}
          </span>
        </>
      )}
    </div>
  );
}