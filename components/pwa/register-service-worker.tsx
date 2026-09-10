"use client";

import { useEffect } from "react";

/**
 * Registers public/sw.js once, on mount, client-side only.
 *
 * Renders nothing — this is a side-effect-only component, not a piece of
 * UI. Skipped outside production so a local `next dev` session never
 * caches its own hot-reloading build output (a stale service worker
 * serving yesterday's JS from cache is a classic, confusing local-dev
 * bug this sidesteps entirely rather than working around later).
 *
 * No setState anywhere in here, so there's nothing for
 * react-hooks/set-state-in-effect to flag — registration is fire-and-
 * forget; nothing in this component's own render depends on whether it
 * succeeded.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js").catch((error) => {
      // Best-effort. A failed registration (an unsupported browser, a
      // blocked script) should never break the app itself — Busihub
      // works the same either way, it just won't cache assets or show
      // the offline fallback page for this visitor.
      console.error("Service worker registration failed", error);
    });
  }, []);

  return null;
}