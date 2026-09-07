"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_TREE, isGroupVisible, isLeafVisible, type NavGroup, type NavPermissions } from "./nav-items";

interface SidebarProps {
  permissions: NavPermissions;
  businessName: string;
  /** Mobile drawer state, owned by AppShell. Ignored at md: and up, where
   *  the sidebar is always visible. */
  open: boolean;
  onClose: () => void;
}

function isLeafActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

// Every interactive nav element gets the same explicit focus ring
// (matching components/ui/button.tsx's own focus-visible treatment)
// rather than relying on the browser's default outline, which varies by
// browser and didn't previously appear anywhere in this file.
const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

export function Sidebar({ permissions, businessName, open, onClose }: SidebarProps) {
  const pathname = usePathname();

  // Whether a group is open is derived during render, not tracked with an
  // effect: by default a group is open exactly when it holds the current
  // route, recomputed fresh on every navigation with no extra render pass.
  // A hand click overrides that default for its own label until the next
  // click — recorded here rather than synced via useEffect, since setting
  // state from an effect just to mirror something already computable from
  // pathname is the exact pattern that tripped react-hooks/set-state-in-effect
  // on the notification bell (see notification-bell.tsx's refresh()).
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  function isGroupExpanded(entry: NavGroup): boolean {
    const override = overrides[entry.label];
    if (override !== undefined) return override;
    return entry.children.some((child) => isLeafActive(pathname, child.href));
  }

  function toggleGroup(entry: NavGroup) {
    setOverrides((prev) => ({ ...prev, [entry.label]: !isGroupExpanded(entry) }));
  }

  return (
    <>
      {/* Backdrop — mobile only. Tapping it closes the drawer, same as the
          notification bell's own click-outside handling. */}
      {open ? (
        <div
          className="fixed inset-0 z-30 animate-fade-in bg-black/40 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col overflow-hidden border-r border-neutral-200 bg-white transition-transform duration-200 ease-in-out dark:border-neutral-800 dark:bg-neutral-900",
          // At md+ the drawer becomes a normal, in-flow column: sticky (not
          // fixed) so it takes up real width in the parent flex row and
          // pushes the content beside it, instead of floating over it.
          "md:sticky md:top-0 md:h-screen md:w-64 md:max-w-none md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-neutral-200 px-4 py-4 dark:border-neutral-800">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white shadow-sm">
              B
            </span>
            <span className="truncate font-semibold">{businessName}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="flex-shrink-0 rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 dark:text-neutral-400 dark:hover:bg-neutral-800 md:hidden"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-3">
          <ul className="flex flex-col gap-0.5">
            {NAV_TREE.map((entry) => {
              if (entry.kind === "leaf") {
                if (!isLeafVisible(entry, permissions)) return null;
                const Icon = entry.icon;
                const active = isLeafActive(pathname, entry.href);
                return (
                  <li key={entry.href}>
                    <Link
                      href={entry.href}
                      onClick={onClose}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                        FOCUS_RING,
                        active
                          ? "bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"
                          : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                      )}
                    >
                      <Icon className="h-[18px] w-[18px] flex-shrink-0" aria-hidden="true" />
                      <span className="truncate">{entry.label}</span>
                    </Link>
                  </li>
                );
              }

              if (!isGroupVisible(entry, permissions)) return null;
              const GroupIcon = entry.icon;
              const isExpanded = isGroupExpanded(entry);
              const hasActiveChild = entry.children.some((child) => isLeafActive(pathname, child.href));

              return (
                <li key={entry.label}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(entry)}
                    aria-expanded={isExpanded}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors",
                      FOCUS_RING,
                      hasActiveChild
                        ? "text-brand-700 dark:text-brand-300"
                        : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    )}
                  >
                    <GroupIcon className="h-[18px] w-[18px] flex-shrink-0" aria-hidden="true" />
                    <span className="flex-1 truncate">{entry.label}</span>
                    <ChevronDown
                      className={cn("h-4 w-4 flex-shrink-0 transition-transform", isExpanded && "rotate-180")}
                      aria-hidden="true"
                    />
                  </button>
                  {isExpanded ? (
                    <ul className="ml-4 mt-0.5 flex flex-col gap-0.5 border-l border-neutral-200 pl-4 dark:border-neutral-800">
                      {entry.children.map((child) => {
                        if (!isLeafVisible(child, permissions)) return null;
                        const ChildIcon = child.icon;
                        const active = isLeafActive(pathname, child.href);
                        return (
                          <li key={child.href}>
                            <Link
                              href={child.href}
                              onClick={onClose}
                              aria-current={active ? "page" : undefined}
                              className={cn(
                                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                                FOCUS_RING,
                                active
                                  ? "bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"
                                  : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                              )}
                            >
                              <ChildIcon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                              <span className="truncate">{child.label}</span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>
    </>
  );
}