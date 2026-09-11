"use client";

import { useCallback, useEffect, useState } from "react";
import { listQueuedSales, QUEUE_CHANGED_EVENT, type QueuedSale } from "./queue";
import { flushOfflineQueue } from "./sync";
import { useOnlineStatus } from "./use-online-status";

export interface PendingSyncState {
  sales: QueuedSale[];
  count: number;
  /** How many of `sales` failed their last sync attempt (has lastError set). */
  failedCount: number;
  syncing: boolean;
  /** True only right after a flush that never got a response from the
   *  server at all — distinct from a per-sale failure, which lives on
   *  the sale itself (sales[].lastError) instead. */
  networkError: boolean;
  syncNow: () => void;
}

/**
 * The one place that reads the offline queue for display and decides
 * when to try draining it: once on mount (covers reopening the app after
 * connectivity came back while it was closed) and again every time the
 * browser fires 'online'. Mounted once, in components/ui/connection-
 * status.tsx (root layout) — the till writes to the queue directly
 * (lib/offline/queue.ts's enqueueSale) but doesn't need its own copy of
 * this hook, since QUEUE_CHANGED_EVENT is how the two halves stay in
 * sync without knowing about each other.
 *
 * There is deliberately no service-worker-driven retry here (no
 * `sync` event registration in public/sw.js) — see that file's header
 * and docs/ARCHITECTURE.md's Phase 17 changelog entry for why: it would
 * mean a second copy of this same logic living in plain, unbundled JS
 * (service workers can't import this module graph), for a browser API
 * with no support in Safari/iOS at all. A cashier's till is not normally
 * closed mid-shift, so "retry when this tab notices it's back online, or
 * when the cashier taps Sync now" covers the realistic case; the harder,
 * riskier mechanism was deliberately left out rather than half-built.
 */
export function usePendingSync(): PendingSyncState {
  const online = useOnlineStatus();
  const [sales, setSales] = useState<QueuedSale[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [networkError, setNetworkError] = useState(false);

  const refresh = useCallback(() => {
    listQueuedSales()
      .then(setSales)
      .catch((err) => console.error("usePendingSync: could not read the offline queue", err));
  }, []);

  const syncNow = useCallback(() => {
    setSyncing(true);
    setNetworkError(false);
    flushOfflineQueue()
      .then((result) => {
        setNetworkError(result.networkError);
        refresh();
      })
      .catch((err) => console.error("usePendingSync: flush failed unexpectedly", err))
      .finally(() => setSyncing(false));
  }, [refresh]);

  useEffect(() => {
    refresh();
    window.addEventListener(QUEUE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(QUEUE_CHANGED_EVENT, refresh);
  }, [refresh]);

  // Deferred a tick for the same reason as till.tsx's payment-method
  // reset: syncNow() calls setSyncing synchronously as its first line, and
  // calling that straight from an effect body trips
  // react-hooks/set-state-in-effect (it would force a second render in
  // the same commit as the 'online' flip). A zero-delay setTimeout moves
  // it off the synchronous effect-commit path without changing when the
  // sync actually kicks off in practice — the browser firing 'online' is
  // already an async event, not something happening mid-render.
  useEffect(() => {
    if (!online) return;
    const timeoutId = setTimeout(() => syncNow(), 0);
    return () => clearTimeout(timeoutId);
  }, [online, syncNow]);

  return {
    sales,
    count: sales.length,
    failedCount: sales.filter((s) => Boolean(s.lastError)).length,
    syncing,
    networkError,
    syncNow,
  };
}