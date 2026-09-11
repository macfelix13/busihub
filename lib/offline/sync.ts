"use client";

import { listQueuedSales, removeQueuedSale, markQueuedSaleFailed, type QueuedSale } from "./queue";

/**
 * Only the fields /api/sync's schema (lib/validation/offline-sync.ts)
 * actually accepts — a queued record also carries display-only fields
 * (queuedAt, summary, lastError, lastAttemptAt) that schema has no place
 * for and would reject the request over if they were sent along.
 */
function toWireSale(sale: QueuedSale) {
  return {
    clientTransactionId: sale.clientTransactionId,
    branchId: sale.branchId,
    customerId: sale.customerId,
    paymentMethod: sale.paymentMethod,
    amountTendered: sale.amountTendered,
    items: sale.items,
  };
}

export interface FlushResult {
  synced: number;
  failed: number;
  /**
   * True only when the batch POST itself never got a response — still
   * offline, or a genuine network failure — as opposed to the server
   * responding with per-item results. Nothing in the queue is touched in
   * this case, which is what makes it always safe to call this
   * speculatively (on load, on the browser's 'online' event, from a
   * manual "Sync now" button) without risking a queued sale.
   */
  networkError: boolean;
}

let flushing = false;

/**
 * Sends every queued sale to /api/sync in one batch and reconciles the
 * result: a sale the server confirms is removed from the queue, one it
 * rejects keeps its place with the server's own message attached (shown
 * to the cashier via lib/offline/use-pending-sync.ts), and a request that
 * never reaches the server at all leaves the whole queue untouched.
 *
 * Each queued record carries display-only fields (`queuedAt`, `summary`,
 * `lastError`, `lastAttemptAt`) alongside the actual sale — those are
 * stripped before the request is built, since /api/sync's schema
 * (lib/validation/offline-sync.ts) has no place for them and would
 * reject a payload that included them.
 *
 * Guarded against overlapping calls with a module-level flag rather than
 * anything more elaborate: this only ever runs on one tab's main thread,
 * the triggers are infrequent (a handful of user/browser-driven events,
 * never a tight loop), and the worst two overlapping flushes could do is
 * send the same batch twice — create_sale()'s own idempotency key (0052)
 * already makes a genuine duplicate send land exactly once either way.
 */
export async function flushOfflineQueue(): Promise<FlushResult> {
  if (flushing) return { synced: 0, failed: 0, networkError: false };
  flushing = true;
  try {
    const queued = await listQueuedSales();
    if (queued.length === 0) return { synced: 0, failed: 0, networkError: false };

    let response: Response;
    try {
      response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sales: queued.map(toWireSale) }),
      });
    } catch {
      return { synced: 0, failed: 0, networkError: true };
    }

    if (!response.ok) {
      // A non-2xx status here means something is wrong with the WHOLE
      // request (malformed body, not signed in, a server error) rather
      // than any one sale — there's nothing item-specific to record, and
      // retrying the identical payload won't help on its own, so this is
      // surfaced the same as a network error rather than blamed on any
      // individual queued sale.
      return { synced: 0, failed: 0, networkError: true };
    }

    let body: { results?: { clientTransactionId: string; status: "ok" | "error"; error?: string }[] };
    try {
      body = await response.json();
    } catch {
      return { synced: 0, failed: 0, networkError: true };
    }

    let synced = 0;
    let failed = 0;
    for (const result of body.results ?? []) {
      if (result.status === "ok") {
        await removeQueuedSale(result.clientTransactionId);
        synced += 1;
      } else {
        await markQueuedSaleFailed(result.clientTransactionId, result.error ?? "Couldn't sync this sale.");
        failed += 1;
      }
    }
    return { synced, failed, networkError: false };
  } finally {
    flushing = false;
  }
}