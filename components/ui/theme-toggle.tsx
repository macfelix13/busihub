"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

/** Same key app/layout.tsx's no-flash inline script reads on every load. */
const STORAGE_KEY = "busihub-theme";

function applyTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  try {
    localStorage.setItem(STORAGE_KEY, dark ? "dark" : "light");
  } catch {
    // Private browsing, or storage disabled by the browser/organization —
    // the toggle still works for the rest of this page load, it just
    // won't be remembered the next time this device opens Busihub.
  }
}

/**
 * A per-device light/dark toggle — not a per-user account setting and not
 * a business-wide one. See app/layout.tsx's THEME_INIT_SCRIPT for the
 * full reasoning: a till terminal's browser is itself the right place for
 * this preference to live, so nobody has to re-set it every shift change,
 * and it works identically for a signed-out visitor on the marketing
 * site (where there is no account to attach a preference to at all).
 */
export function ThemeToggle({ className }: { className?: string }) {
  // Starts unknown rather than assuming "light": the inline script in
  // app/layout.tsx already decided the real answer before this component
  // ever mounts (that's the whole point of it being a synchronous script
  // rather than a React effect), so this just reads that back instead of
  // guessing and risking the icon flipping a frame after paint.
  const [isDark, setIsDark] = useState<boolean | null>(null);

  useEffect(() => {
    // Not called directly in the effect body — same pattern established in
    // components/notifications/notification-bell.tsx's own refresh effect:
    // a function that setState()s must only ever run from inside a timer
    // callback here, never as a bare statement in the effect itself
    // (react-hooks/set-state-in-effect).
    const timeout = window.setTimeout(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  if (isDark === null) {
    // Same footprint as the real button, so nothing shifts once the
    // effect above resolves one frame later.
    return <span className={cn("inline-block h-9 w-9 flex-shrink-0", className)} aria-hidden="true" />;
  }

  return (
    <button
      type="button"
      onClick={() => {
        const next = !isDark;
        setIsDark(next);
        applyTheme(next);
      }}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={cn(
        "flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-950 dark:text-ink-muted dark:hover:bg-white/10",
        className
      )}
    >
      {isDark ? <Sun className="h-[18px] w-[18px]" aria-hidden="true" /> : <Moon className="h-[18px] w-[18px]" aria-hidden="true" />}
    </button>
  );
}