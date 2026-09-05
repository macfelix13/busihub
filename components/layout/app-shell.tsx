"use client";

import { useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { Sidebar } from "./sidebar";
import type { NavPermissions } from "./nav-items";

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
    <div className="flex min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <Sidebar
        permissions={permissions}
        businessName={businessName}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900 sm:px-6">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className="-ml-1.5 flex-shrink-0 rounded-lg p-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 md:hidden"
          >
            <Menu className="h-6 w-6" aria-hidden="true" />
          </button>
          <span className="truncate font-semibold md:hidden">{businessName}</span>
          <div className="ml-auto flex flex-shrink-0 items-center gap-1.5 sm:gap-3">
            {notificationSlot}
            <span className="hidden max-w-[10rem] truncate text-sm text-neutral-500 sm:inline">{userLabel}</span>
            {logoutSlot}
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}