"use client";

import { useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { Sidebar } from "./sidebar";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import type { NavPermissions } from "./nav-items";

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-950";

/** "Jane Doe" -> "JD"; a lone name -> its first letter. Purely a small
 *  visual touch for the header's profile chip — falls back gracefully to
 *  "?" for an empty label rather than rendering nothing. */
function initialsFor(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

interface AppShellProps {
  permissions: NavPermissions;
  businessName: string;
  userLabel: string;
  /** Pre-rendered elements from the server layout — NotificationBell and
   *  LogoutButton can't be imported and rendered directly inside this
   *  client component (LogoutButton is a Server Component under the hood),
   *  so the layout renders them and passes the result down as children. */
  notificationSlot: ReactNode;
  logoutSlot: ReactNode;
  children: ReactNode;
}

export function AppShell({
  permissions,
  businessName,
  userLabel,
  notificationSlot,
  logoutSlot,
  children,
}: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-canvas dark:bg-canvas-dark">
      <Sidebar
        permissions={permissions}
        businessName={businessName}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* border-b added 2026-09-11 alongside the sidebar's border-r, same
            reason: this header's bg-canvas-dark/90 is the same near-black
            green as the page content behind it in dark mode, so the sticky
            header had no visible edge to separate it once you scroll
            content underneath it. */}
        <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-neutral-200/70 bg-canvas/90 px-4 py-4 backdrop-blur-sm dark:border-surface-line dark:bg-canvas-dark/90 sm:px-6">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className={`-ml-1.5 flex-shrink-0 rounded-lg p-1.5 text-neutral-600 transition-colors hover:bg-black/5 dark:text-ink-muted dark:hover:bg-white/10 md:hidden ${FOCUS_RING}`}
          >
            <Menu className="h-6 w-6" aria-hidden="true" />
          </button>
          <span className="truncate font-semibold md:hidden">{businessName}</span>
          <div className="ml-auto flex flex-shrink-0 items-center gap-1.5 sm:gap-3">
            <ThemeToggle />
            {notificationSlot}
            <div className="hidden h-6 w-px bg-neutral-300/60 dark:bg-white/10 sm:block" aria-hidden="true" />
            <div className="hidden items-center gap-2 rounded-full bg-white py-1 pl-1 pr-3 shadow-sm shadow-neutral-900/5 dark:bg-surface-card sm:flex">
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-lime-400 text-xs font-semibold text-brand-950">
                {initialsFor(userLabel)}
              </span>
              <span className="max-w-[10rem] truncate text-sm font-medium text-neutral-700 dark:text-ink">
                {userLabel}
              </span>
            </div>
            {logoutSlot}
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}