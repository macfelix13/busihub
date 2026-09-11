"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";

/**
 * Every link here lands somewhere real. The public pages the rest of
 * this app actually ships are /login and /register (app/(auth)/) — there
 * is no separate marketing site with its own /pricing, /resources, etc.,
 * so "Features", "Solutions", "How It Works", "Pricing" and "FAQ" are
 * same-page anchors into the sections below rather than routes that
 * don't exist yet. That keeps every nav item and button clickable today
 * instead of pointing at a 404.
 */
const NAV_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#solutions", label: "Solutions" },
  { href: "#how-it-works", label: "How It Works" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

export function Navbar() {
  const [open, setOpen] = useState(false);

  // Lock background scroll while the mobile menu sheet is open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-neutral-200/80 bg-canvas/90 backdrop-blur-sm dark:border-surface-line/80 dark:bg-canvas-dark/90">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-6" aria-label="Primary">
        <Link href="/" className="flex items-center gap-2" onClick={() => setOpen(false)}>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-lime-400 text-sm font-bold text-brand-950">
            B
          </span>
          <span className="text-lg font-semibold tracking-tight text-neutral-900 dark:text-ink">Busihub</span>
        </Link>

        <div className="hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-lg px-3 py-2 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-ink-muted dark:hover:bg-surface dark:hover:text-ink"
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="hidden items-center gap-2 lg:flex">
          <ThemeToggle />
          <Link href="/login" className="rounded-xl px-4 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 dark:text-ink dark:hover:bg-surface">
            Sign in
          </Link>
          <Link href="/register">
            <Button className="px-5">Get started</Button>
          </Link>
        </div>

        <div className="flex items-center gap-1 lg:hidden">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="flex h-11 w-11 items-center justify-center rounded-xl text-neutral-700 hover:bg-neutral-100 dark:text-ink dark:hover:bg-surface"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </nav>

      {open ? (
        <div id="mobile-menu" className="border-t border-neutral-200 bg-white px-5 py-4 dark:border-surface-line dark:bg-surface-deep lg:hidden">
          <div className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-xl px-3 py-3 text-base font-medium text-neutral-700 hover:bg-neutral-100 dark:text-ink dark:hover:bg-surface"
              >
                {link.label}
              </a>
            ))}
          </div>
          <div className="mt-4 flex flex-col gap-2 border-t border-neutral-200 pt-4 dark:border-surface-line">
            <Link href="/login" onClick={() => setOpen(false)}>
              <Button variant="secondary" className="w-full">
                Sign in
              </Button>
            </Link>
            <Link href="/register" onClick={() => setOpen(false)}>
              <Button className="w-full">Get started</Button>
            </Link>
          </div>
        </div>
      ) : null}
    </header>
  );
}