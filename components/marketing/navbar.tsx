"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";

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
    <header className="sticky top-0 z-40 border-b border-neutral-200/80 bg-white/85 backdrop-blur supports-[backdrop-filter]:bg-white/70 dark:border-neutral-800/80 dark:bg-neutral-950/85 dark:supports-[backdrop-filter]:bg-neutral-950/70">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-6" aria-label="Primary">
        <Link href="/" className="flex items-center gap-2" onClick={() => setOpen(false)}>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            B
          </span>
          <span className="text-lg font-semibold tracking-tight text-neutral-900 dark:text-white">Busihub</span>
        </Link>

        <div className="hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-lg px-3 py-2 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-900 dark:hover:text-white"
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="hidden items-center gap-2 lg:flex">
          <Link href="/login" className="rounded-xl px-4 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-900">
            Sign in
          </Link>
          <Link href="/register">
            <Button className="px-5">Get started</Button>
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          className="flex h-11 w-11 items-center justify-center rounded-xl text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-900 lg:hidden"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </nav>

      {open ? (
        <div id="mobile-menu" className="border-t border-neutral-200 bg-white px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950 lg:hidden">
          <div className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-xl px-3 py-3 text-base font-medium text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-900"
              >
                {link.label}
              </a>
            ))}
          </div>
          <div className="mt-4 flex flex-col gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
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