"use client";

import type { QueuedSaleInput } from "@/lib/validation/offline-sync";

/**
 * The offline sale outbox — Phase 17's client half. A sale rung up at the
 * till while there is no connection is written here instead of being sent
 * anywhere, and lib/offline/sync.ts is what later drains it into
 * /api/sync (migration 0052's idempotent, RLS-scoped endpoint).
 *
 * IndexedDB, not localStorage: a queued sale can hold a cart of several
 * items plus a running total, and this needs a real per-record store with
 * a stable key to update or delete a single entry (a synced one removed,
 * a failed one annotated) without ever touching to the others — awkward
 * and error-prone to build correctly on top of a single JSON blob in
 * localStorage. It also keeps this off the main thread's synchronous
 * storage API, which matters more here than for the small preferences
 * localStorage is used for elsewhere in this app.
 *
 * Every function here opens and closes its own connection rather than
 * holding one open across the module's lifetime — these are infrequent,
 * one-off operations (queue a sale, flush the queue), not a hot path, so
 * there is nothing to gain from a persistent connection and one less
 * thing to leak if a tab is left open a long time.
 */

const DB_NAME = "busihub-offline-sales";
const DB_VERSION = 1;
const STORE = "pending_sales";

/**
 * Fired on `window` whenever the queue changes (a sale queued, synced, or
 * marked failed) — the one thing IndexedDB has no built-in way to tell
 * the rest of the page about. lib/offline/use-pending-sync.ts listens for
 * this instead of polling, so the till (which writes to the queue) and
 * the global connection banner (which only reads it) both see the same
 * count without either knowing the other exists.
 */
export const QUEUE_CHANGED_EVENT = "busihub:offline-queue-changed";

function notifyQueueChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT));
  }
}

/**
 * Shown to the cashier while the sale is still sitting in the queue —
 * never sent to /api/sync, which recomputes the real total, tax, and
 * receipt number itself from the catalog exactly as a live sale would
 * (create_sale() takes no price or total parameter at all, online or
 * synced). This is a snapshot for display only, taken from the same
 * catalog data the till already had loaded.
 */
export interface QueuedSaleSummary {
  itemCount: number;
  total: number;
  branchName: string;
  cashierName: string;
}

export interface QueuedSale extends QueuedSaleInput {
  /** ISO timestamp, set when queued — used for FIFO ordering and for
   *  showing the cashier how long something has been waiting. */
  queuedAt: string;
  summary: QueuedSaleSummary;
  /** Set by lib/offline/sync.ts after a failed sync attempt (the
   *  database's own message, e.g. "Not enough stock"); cleared again the
   *  next time a flush is attempted. Absent means either never attempted
   *  yet, or the last attempt didn't get a response for this item at all
   *  (a network-level failure — see FlushResult.networkError). */
  lastError?: string;
  lastAttemptAt?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser has no offline storage available."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // Keyed on the same id create_sale()'s idempotency check (0052)
        // uses — a `put` with the same clientTransactionId always
        // overwrites the same record, so this store can never end up
        // with two rows for one queued sale even if enqueueSale() were
        // ever called twice for it.
        db.createObjectStore(STORE, { keyPath: "clientTransactionId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the offline sale queue."));
  });
}

export async function enqueueSale(sale: QueuedSale): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(sale);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not save this sale for later."));
    });
  } finally {
    db.close();
  }
  notifyQueueChanged();
}

/** Oldest first — sales sync in the order they actually happened. */
export async function listQueuedSales(): Promise<QueuedSale[]> {
  const db = await openDb();
  try {
    const sales = await new Promise<QueuedSale[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result as QueuedSale[]);
      request.onerror = () => reject(request.error ?? new Error("Could not read the offline sale queue."));
    });
    return sales.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  } finally {
    db.close();
  }
}

export async function removeQueuedSale(clientTransactionId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(clientTransactionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not clear a synced sale from the queue."));
    });
  } finally {
    db.close();
  }
  notifyQueueChanged();
}

export async function markQueuedSaleFailed(clientTransactionId: string, error: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const getRequest = store.get(clientTransactionId);
      getRequest.onsuccess = () => {
        const existing = getRequest.result as QueuedSale | undefined;
        // Already gone (a concurrent flush already synced or removed it)
        // — nothing to annotate.
        if (existing) {
          store.put({ ...existing, lastError: error, lastAttemptAt: new Date().toISOString() });
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not record a sync error."));
    });
  } finally {
    db.close();
  }
  notifyQueueChanged();
}