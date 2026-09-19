"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
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
// browser and didn't previously appear anywhere in this file. Lime, not
// brand-600, because brand-600 barely shows up against this sidebar's own
// dark green background — the whole point of a focus ring is contrast.
const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-400";

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

  // Desktop/tablet-only "collapse to icon rail" toggle, requested directly
  // by the user. Deliberately plain useState(false) rather than restored
  // from localStorage: reading a browser API before the first paint to
  // decide the initial value is exactly what causes a server/client
  // hydration mismatch (the server has no window to read from), and
  // fixing that properly needs a pre-hydration inline script the way
  // lib/theme.ts's businessThemeOverrideScript() does for the dark/light
  // override — real added complexity for a preference that, unlike the
  // whole page's color scheme, is low-stakes to just reset to expanded on
  // a fresh page load. It DOES persist across in-app navigation, since
  // this component lives inside the shared (app) layout and isn't
  // remounted between pages in the same tab. Only affects md: and up —
  // every collapse-driven class below is md:-prefixed, so the mobile
  // drawer (which owns its own open/close state above) is untouched.
  const [collapsed, setCollapsed] = useState(false);

  function isGroupExpanded(entry: NavGroup): boolean {
    const override = overrides[entry.label];
    if (override !== undefined) return override;
    return entry.children.some((child) => isLeafActive(pathname, child.href));
  }

  function toggleGroup(entry: NavGroup) {
    setOverrides((prev) => ({ ...prev, [entry.label]: !isGroupExpanded(entry) }));
  }

  // Shared between the click-driven inline list (mobile, and desktop when
  // not collapsed) and the hover/focus flyout (desktop, collapsed only) —
  // kept as one function so the two never drift out of sync with each
  // other over time.
  function renderGroupChildren(entry: NavGroup) {
    return entry.children.map((child) => {
      if (!isLeafVisible(child, permissions)) return null;
      const ChildIcon = child.icon;
      const active = isLeafActive(pathname, child.href);
      return (
        <li key={child.href}>
          <Link
            href={child.href}
            onClick={onClose}
            // See the top-level Link below — same reason.
            prefetch={false}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              FOCUS_RING,
              active ? "bg-surface text-lime-300" : "text-brand-200 hover:bg-white/5 hover:text-white"
            )}
          >
            <ChildIcon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span className="truncate">{child.label}</span>
          </Link>
        </li>
      );
    });
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
          // border-r added 2026-09-11: brand-950 (this sidebar) and
          // canvas.dark (the main content background, in dark mode) are
          // now the exact same #082c24 following this phase's color
          // retune — without a visible seam here the sidebar and the page
          // read as one undifferentiated dark-green field. surface-line is
          // the brand spec's own "Border" color (#28564B), used for
          // exactly this purpose everywhere else (Card, Modal, Field).
          //
          // No overflow-hidden here (removed when the collapse feature was
          // added) — a group's hover flyout below is positioned absolute
          // and needs to escape this box's edge; the mobile slide
          // animation and the nav's own vertical scrolling never actually
          // depended on it, since <nav> already clips its own scroll area
          // with overflow-y-auto independently.
          "fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col border-r border-surface-line bg-brand-950 text-brand-50 transition-transform duration-200 ease-in-out",
          // At md+ the drawer becomes a normal, in-flow column: sticky (not
          // fixed) so it takes up real width in the parent flex row and
          // pushes the content beside it, instead of floating over it.
          "md:sticky md:top-0 md:h-screen md:max-w-none md:translate-x-0",
          collapsed ? "md:w-20" : "md:w-64",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className={cn("flex flex-shrink-0 items-center justify-between gap-2 px-4 py-5", collapsed && "md:justify-center md:px-2")}>
          <div className={cn("flex min-w-0 items-center gap-2.5", collapsed && "md:justify-center")}>
            {/* text-accent-fg, not text-brand-950 — same Primary-color
                contrast reasoning as components/ui/button.tsx's primary
                variant: bg-lime-400 is dynamic now. */}
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-lime-400 text-sm font-bold text-accent-fg shadow-sm">
              B
            </span>
            <span className={cn("truncate font-semibold text-white", collapsed && "md:hidden")}>{businessName}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className={cn(
              "flex-shrink-0 rounded-lg p-1.5 text-brand-200 transition-colors hover:bg-white/10 md:hidden",
              FOCUS_RING
            )}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {/* Collapse toggle — desktop/tablet only. The mobile drawer has its
            own open/close affordance above (the header hamburger button in
            app-shell.tsx and this X), so this button only ever renders at
            md: and up. */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand menu" : "Collapse menu"}
          className={cn(
            "hidden flex-shrink-0 items-center gap-2 border-b border-white/10 px-4 py-2.5 text-sm font-medium text-brand-200 transition-colors hover:bg-white/5 hover:text-white md:flex",
            collapsed && "md:justify-center md:px-2",
            FOCUS_RING
          )}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          ) : (
            <>
              <ChevronLeft className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span>Collapse</span>
            </>
          )}
        </button>

        <nav className={cn("flex-1 overflow-y-auto py-3 px-3", collapsed && "md:px-2")}>
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
                      // Phase 17 (Synchronization), client half: every one
                      // of these links sits in the viewport the whole time
                      // (the sidebar is always visible), so Next's default
                      // prefetch-on-visible behavior means an idle till
                      // makes a stream of background fetches with no click
                      // involved at all. That's wasted bandwidth for a
                      // link that's rarely used from most pages, but it's
                      // actively harmful while offline: a background
                      // prefetch that fails can trigger the same
                      // hard-reload fallback a real failed navigation
                      // would (see notification-bell.tsx's fuller
                      // explanation) — dropping the till back to the
                      // static offline.html fallback with no warning,
                      // mid-sale. Explicit navigations (an actual click)
                      // still fetch fresh on demand exactly as before.
                      prefetch={false}
                      aria-current={active ? "page" : undefined}
                      title={collapsed ? entry.label : undefined}
                      className={cn(
                        // active bg retuned 2026-09-11 from a generic
                        // white/10 overlay to the brand spec's actual
                        // "Active item" color (surface, #0D3B32) — see
                        // tailwind.config.ts's `surface` comment.
                        "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                        collapsed && "md:justify-center md:px-2",
                        FOCUS_RING,
                        active
                          ? "bg-surface text-lime-300"
                          : "text-brand-100 hover:bg-white/5 hover:text-white"
                      )}
                    >
                      <Icon className="h-[18px] w-[18px] flex-shrink-0" aria-hidden="true" />
                      <span className={cn("truncate", collapsed && "md:hidden")}>{entry.label}</span>
                    </Link>
                  </li>
                );
              }

              if (!isGroupVisible(entry, permissions)) return null;
              const GroupIcon = entry.icon;
              const isExpanded = isGroupExpanded(entry);
              const hasActiveChild = entry.children.some((child) => isLeafActive(pathname, child.href));

              return (
                <li key={entry.label} className="relative group">
                  {/* Plain `group` (not `md:group`) is deliberate: Tailwind's
                      `group` utility produces no CSS rule of its own — it's
                      only a marker other elements' `group-hover:`/
                      `group-focus-within:` selectors look for by that exact
                      literal class name. Every rule that actually reveals
                      the flyout below is itself `md:`-prefixed, so nothing
                      shows on mobile even though this marker is always
                      present. */}
                  <button
                    type="button"
                    onClick={() => toggleGroup(entry)}
                    aria-expanded={isExpanded}
                    title={collapsed ? entry.label : undefined}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors",
                      collapsed && "md:justify-center md:px-2",
                      FOCUS_RING,
                      hasActiveChild
                        ? "text-lime-300"
                        : "text-brand-100 hover:bg-white/5 hover:text-white"
                    )}
                  >
                    <GroupIcon className="h-[18px] w-[18px] flex-shrink-0" aria-hidden="true" />
                    <span className={cn("flex-1 truncate", collapsed && "md:hidden")}>{entry.label}</span>
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 flex-shrink-0 transition-transform",
                        isExpanded && "rotate-180",
                        collapsed && "md:hidden"
                      )}
                      aria-hidden="true"
                    />
                  </button>
                  {/* Click-driven inline list — used on mobile always, and
                      on desktop whenever the rail isn't collapsed. Hidden
                      at md: while collapsed since there's no room next to
                      an icon-only rail for a label; the flyout below takes
                      over reaching these pages in that state. */}
                  {isExpanded ? (
                    <ul
                      className={cn(
                        "ml-4 mt-0.5 flex flex-col gap-0.5 border-l border-white/10 pl-4",
                        collapsed && "md:hidden"
                      )}
                    >
                      {renderGroupChildren(entry)}
                    </ul>
                  ) : null}
                  {/* Hover/focus flyout — desktop, collapsed only. Reuses
                      renderGroupChildren so this never drifts from the
                      inline list above. group-focus-within, not just
                      group-hover, so a keyboard user tabbing through the
                      rail can reach it too, not only a mouse. */}
                  {collapsed ? (
                    <ul
                      className={cn(
                        "pointer-events-none absolute left-full top-0 z-50 ml-2 hidden w-52 flex-col gap-0.5",
                        "rounded-xl border border-surface-line bg-brand-950 p-2 opacity-0 shadow-lg shadow-black/30",
                        "transition-opacity md:flex",
                        "md:group-hover:pointer-events-auto md:group-hover:opacity-100",
                        "md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100"
                      )}
                    >
                      <li className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-brand-300">
                        {entry.label}
                      </li>
                      {renderGroupChildren(entry)}
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