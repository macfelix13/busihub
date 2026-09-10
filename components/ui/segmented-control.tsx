import Link from "next/link";
import type { UrlObject } from "url";
import { cn } from "@/lib/utils";

/**
 * The filter-pill / segmented-control look used across the app for status
 * filters, category tabs, and similar small groups of mutually-exclusive
 * choices: a bordered rounded strip with a dark-green (brand-950) pill on
 * whichever option is active.
 *
 * Extracted from ~15 pages that used to hand-roll this exact markup with
 * an inline template string per option — each one independently deciding
 * the active/inactive classes and, before this pass, several of them still
 * hardcoding the old bg-brand-600 rather than the current brand-950 the
 * rest of the redesigned app uses. One component now owns the look, so a
 * future palette change only has to happen here.
 *
 * Two option shapes, matching how the pages in the wild actually use it:
 *  - `href` set → renders a Next.js Link (query-param-driven filters,
 *    the common case — a particular filter combination is a bookmarkable
 *    URL).
 *  - `onClick` set instead → renders a plain button (a couple of pages,
 *    e.g. the product/service toggle on the create-product form, flip
 *    local component state rather than navigating).
 */

export interface SegmentedControlOption {
  key: string;
  label: React.ReactNode;
  active: boolean;
  /** Present for a link-mode option — a Next.js Link href. */
  href?: string | UrlObject;
  /** Present for a button-mode option (local state, not the URL). */
  onClick?: () => void;
  disabled?: boolean;
  /** Extra classes for this one pill — e.g. whitespace-nowrap on a row of many long labels. */
  className?: string;
}

export interface SegmentedControlProps {
  options: SegmentedControlOption[];
  /** Extra classes on the outer bordered strip — e.g. `self-start`. */
  className?: string;
  /**
   * Pill padding. "sm" (default) is the px-3/py-1.5 size used by every
   * query-param filter row. "md" is the slightly larger px-4/py-2 size
   * used by the product/service toggle on the create-product form.
   */
  size?: "sm" | "md";
}

const SIZE_CLASSES: Record<NonNullable<SegmentedControlProps["size"]>, string> = {
  sm: "px-3 py-1.5",
  md: "px-4 py-2",
};

export function SegmentedControl({ options, className, size = "sm" }: SegmentedControlProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap gap-1 rounded-xl border border-neutral-200 p-1 dark:border-neutral-800",
        className
      )}
    >
      {options.map((option) => {
        const optionClassName = cn(
          "rounded-lg text-sm font-medium transition-colors",
          SIZE_CLASSES[size],
          option.active
            ? "bg-brand-950 text-white"
            : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white",
          option.disabled && "pointer-events-none opacity-50",
          option.className
        );

        if (option.href !== undefined) {
          return (
            <Link
              key={option.key}
              href={option.href}
              aria-current={option.active ? "page" : undefined}
              className={optionClassName}
            >
              {option.label}
            </Link>
          );
        }

        return (
          <button
            key={option.key}
            type="button"
            onClick={option.onClick}
            disabled={option.disabled}
            aria-pressed={option.active}
            className={optionClassName}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}