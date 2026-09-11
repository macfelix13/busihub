"use client";

import { useId, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { categoryIconComponent } from "@/lib/ui/category-icons";

export interface CategoryComboboxOption {
  id: string;
  name: string;
  icon?: string | null;
}

interface CategoryComboboxProps {
  name: string;
  label?: string;
  categories: CategoryComboboxOption[];
  defaultValue?: string;
  error?: string;
  /**
   * Whether the caller may create a brand-new category if what they type
   * doesn't match one. Defaults to true (the create-product page always
   * requires products.create already, which is the same permission
   * needed to add a category). The edit page passes this explicitly,
   * since editing a product only needs products.edit — see
   * docs/RBAC.md's "Categories reuse products.*" section.
   */
  canCreate?: boolean;
}

/**
 * A category is optional and free-typed here, not chosen from a locked
 * list (Section: "categories should be optional and let you write your
 * own"). Type an existing category's name to reuse it — matched
 * case-insensitively server-side (app/(app)/products/actions.ts's
 * resolveCategoryId), so "hair" and "Hair" never become two separate
 * categories — or type a brand-new one and it's created automatically
 * when the form saves. Deliberately a plain filter-as-you-type list, not
 * a portal/positioning library — matching every other "plain" UI
 * component in this app (see components/ui/confirm-dialog.tsx's own
 * comment on why).
 */
export function CategoryCombobox({
  name,
  label = "Category",
  categories,
  defaultValue = "",
  error,
  canCreate = true,
}: CategoryComboboxProps) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [text, setText] = useState(defaultValue);
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    const pool = q.length > 0 ? categories.filter((c) => c.name.toLowerCase().includes(q)) : categories;
    return pool.slice(0, 8);
  }, [categories, text]);

  // Only checked against the categories this form was given (active ones
  // for products/services — see the pages that render this component).
  // An archived category with the same name is still resolved and
  // reactivated server-side, so typing one is never actually wrong — this
  // hint just doesn't know about it, since archived categories aren't in
  // the suggestion list either.
  const exactMatch = categories.some((c) => c.name.trim().toLowerCase() === text.trim().toLowerCase());
  const willCreate = text.trim().length > 0 && !exactMatch;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-neutral-800 dark:text-ink">
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          name={name}
          autoComplete="off"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // A short delay, not an immediate close: a click on a suggestion
          // below fires blur first, and closing right away would unmount
          // the list before that click's onClick ever runs.
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          placeholder="Uncategorized — type to choose or add one"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            "min-h-[44px] w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 pr-9 text-base text-neutral-900",
            "focus:border-lime-500 focus:outline-none focus:ring-2 focus:ring-lime-400/40",
            "dark:border-surface-line dark:bg-surface dark:text-ink",
            error && "border-red-500 focus:border-red-500 focus:ring-red-500/30"
          )}
        />
        {text ? (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setText("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-neutral-400 hover:text-neutral-600 dark:text-ink-muted dark:hover:text-ink"
            aria-label="Clear category"
          >
            ✕
          </button>
        ) : null}
        {open && matches.length > 0 ? (
          <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-neutral-200 bg-white py-1 shadow-lg dark:border-surface-line dark:bg-surface-card">
            {matches.map((c) => {
              const Icon = categoryIconComponent(c.icon);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setText(c.name);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-sm hover:bg-neutral-50 dark:hover:bg-surface/60"
                  >
                    {Icon ? <Icon className="h-4 w-4 text-neutral-400" aria-hidden="true" /> : null}
                    {c.name}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      {willCreate ? (
        canCreate ? (
          <p className="text-xs text-neutral-500 dark:text-ink-muted">&ldquo;{text.trim()}&rdquo; will be added as a new category.</p>
        ) : (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            No category matches &ldquo;{text.trim()}&rdquo; — choose one from the list, or ask an admin to add it.
          </p>
        )
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}