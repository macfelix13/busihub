/**
 * Busihub's service worker.
 *
 * This is deliberately narrow. It does two things and nothing else:
 *
 *   1. Caches the app's own static assets (the Next.js build output under
 *      /_next/static/, the manifest, the icons) so a repeat visit loads
 *      instantly and the app shell survives a dropped connection.
 *   2. Serves a branded /offline.html instead of the browser's own
 *      connection-error page when a page navigation fails while offline.
 *
 * It does NOT cache API/data responses, or intercept anything that isn't
 * a plain same-origin GET. Every Supabase call, every Server Action
 * (POST), every RSC data fetch passes straight through to the network
 * untouched here. If there's no network, those simply fail the same way
 * they would with no service worker installed at all.
 *
 * Offline sales (Phase 17, Synchronization) are handled entirely by
 * ordinary page JavaScript instead — lib/offline/*, driving an IndexedDB
 * outbox and components/ui/connection-status.tsx's "Sync now" — NOT by
 * this file. That was a deliberate choice, not an oversight: a service
 * worker can't import this app's TypeScript module graph (it would mean
 * a second, hand-duplicated copy of the same sync logic in plain JS,
 * with the two able to quietly drift apart), and the obvious reason to
 * put it here anyway — the Background Sync API's `sync` event, so a
 * queued sale could retry even with every tab closed — has no support in
 * Safari/iOS at all. A till isn't normally closed mid-shift, so retrying
 * when a tab notices it's back online (or a cashier taps "Sync now")
 * covers the realistic case; see docs/ARCHITECTURE.md's Phase 17
 * changelog entry for the fuller reasoning.
 *
 * Bump CACHE_VERSION whenever PRECACHE_URLS changes, so old clients drop
 * the stale cache on their next activate rather than serving it forever.
 */
const CACHE_VERSION = "busihub-pwa-v1";

const PRECACHE_URLS = [
  "/offline.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// Same-origin requests worth keeping in cache once seen. Next.js content-
// hashes everything under /_next/static/, so caching it cache-first is
// safe — a given URL's content never changes.
function isCacheableAsset(url) {
  if (url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname.startsWith("/icons/")) return true;
  if (url.pathname === "/manifest.webmanifest") return true;
  if (url.pathname === "/apple-icon.png" || url.pathname === "/icon") return true;
  return false;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // Take over from any previously-waiting service worker immediately
      // rather than waiting for every open tab to close first — this is a
      // small, additive cache layer, not something that risks breaking a
      // page mid-use.
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only ever handle plain GETs. Server Actions and any other mutation
  // are POSTs — never intercepted, never cached, never replayed.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Cross-origin (Supabase, Paystack, anything else) — leave completely
  // untouched.
  if (url.origin !== self.location.origin) return;

  // A page navigation: try the network first (so a signed-in user always
  // sees fresh, permission-checked content while online), and only fall
  // back to the offline page if the network genuinely isn't there.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/offline.html").then((cached) => cached || Response.error()))
    );
    return;
  }

  if (isCacheableAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          // Only cache a genuinely successful, same-origin response —
          // never an error page or an opaque cross-origin fallback.
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else — RSC data fetches, /api/*, anything dynamic — is not
  // handled here at all. No respondWith means the browser's own default
  // network fetch happens exactly as if this service worker didn't exist.
});