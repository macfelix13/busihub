"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { getNotificationFeed, markAllNotificationsRead, markNotificationRead } from "@/lib/notifications/actions";
import { formatNotification } from "@/lib/notifications/format";
import type { NotificationFeedRow, NotificationSeverity } from "@/lib/notifications/types";
import { cn } from "@/lib/utils";
import { SkeletonBlock } from "@/components/ui/skeleton";

// Matches components/ui/button.tsx's own focus-visible treatment — this
// file previously had no explicit focus ring anywhere, relying on browser
// default outlines instead.
const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

// Every 45s while a tab has this open. Not Realtime (see 0034's header for
// why that is deliberately deferred) — slower, but everything from RLS to
// this render is something the test suite can actually prove works.
const POLL_INTERVAL_MS = 45_000;

const SEVERITY_DOT: Record<NotificationSeverity, string> = {
  info: "bg-neutral-400",
  warning: "bg-amber-500",
  critical: "bg-red-500",
};

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationFeedRow[]>([]);
  const [currencyCode, setCurrencyCode] = useState("GHS");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Not called directly in the effect body below — same reasoning as the
  // till's AwaitingPayment panel (app/(app)/sales/awaiting-payment.tsx):
  // a function that setState()s must only ever run from inside a timer
  // callback there, never as a bare statement in the effect itself
  // (react-hooks/set-state-in-effect), even though the actual setState
  // calls here happen well after the `await`, on a later microtask.
  const refresh = useCallback(async () => {
    const result = await getNotificationFeed();
    setNotifications(result.notifications);
    setCurrencyCode(result.currencyCode);
    setError(result.error ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    // setTimeout(…, 0) rather than calling refresh() directly: it still
    // runs on (essentially) the next tick, but as a scheduled callback
    // rather than a synchronous call inside the effect body.
    const initial = window.setTimeout(refresh, 0);
    const interval = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  async function handleItemClick(n: NotificationFeedRow) {
    if (!n.is_read) {
      // Optimistic — the whole point of a bell is that clicking one
      // clears it immediately, not after a round trip.
      setNotifications((prev) => prev.map((x) => (x.dismissal_key === n.dismissal_key ? { ...x, is_read: true } : x)));
      const { error: markError } = await markNotificationRead(n.dismissal_key);
      if (markError) refresh(); // fell out of sync with the server — resync rather than show a false read state
    }
    setOpen(false);
  }

  async function handleMarkAllRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    const { error: markError } = await markAllNotificationsRead();
    if (markError) refresh();
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        className={cn(
          "relative inline-flex h-11 w-11 items-center justify-center rounded-xl text-neutral-600 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
          FOCUS_RING
        )}
      >
        <Bell className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />
        {unreadCount > 0 ? (
          <span className="absolute right-1.5 top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white">
            {unreadCount > 50 ? "50+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        // Anchored to the viewport, not to this button, on narrow screens.
        // The bell sits to the left of "Sign out" in the header (see
        // AppShell), not at the true right edge — so a fixed-width panel
        // anchored with `right-0` to this button's own wrapper can run off
        // the left side of a phone screen. `top-[4.5rem]` matches the
        // header's own height (h-11 button + py-3 padding, plus a small
        // gap) — update it if the header's size ever changes. From `sm:`
        // up there is enough room for the original bell-relative popover.
        <div className="fixed inset-x-4 top-[4.5rem] z-20 animate-slide-down overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-900 sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-80 sm:max-w-[90vw]">
          <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
            <span className="text-sm font-semibold">Notifications</span>
            {unreadCount > 0 ? (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className={cn(
                  "rounded-md text-xs font-medium text-brand-700 transition-colors hover:text-brand-800 dark:text-brand-300",
                  FOCUS_RING
                )}
              >
                Mark all as read
              </button>
            ) : null}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <div className="flex flex-col gap-3 p-4" aria-busy="true" aria-live="polite">
                <span className="sr-only">Loading notifications…</span>
                <SkeletonBlock className="h-10 w-full" />
                <SkeletonBlock className="h-10 w-full" />
                <SkeletonBlock className="h-10 w-3/4" />
              </div>
            ) : error ? (
              <p className="px-4 py-8 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
            ) : notifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-neutral-500">You&apos;re all caught up.</p>
            ) : (
              <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {notifications.map((n) => {
                  const { title, body, href } = formatNotification(n, currencyCode);
                  return (
                    <li key={n.dismissal_key}>
                      <Link
                        href={href}
                        onClick={() => handleItemClick(n)}
                        className={cn(
                          "flex gap-2.5 px-4 py-3 text-sm transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/50",
                          "focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-brand-600",
                          !n.is_read && "bg-brand-50/60 dark:bg-brand-950/20"
                        )}
                      >
                        <span className={cn("mt-1.5 h-2 w-2 flex-shrink-0 rounded-full", SEVERITY_DOT[n.severity])} />
                        <span className="flex flex-col gap-0.5">
                          <span className={cn("font-medium", !n.is_read && "text-neutral-900 dark:text-white")}>
                            {title}
                          </span>
                          <span className="text-neutral-500">{body}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}