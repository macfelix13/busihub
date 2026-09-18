"use client";

import { useFormState } from "react-dom";
import { SubmitButton } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { PermissionsFormState } from "./actions";

const initialState: PermissionsFormState = {};

export interface PermissionCatalogEntry {
  key: string;
  category: string;
  description: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  products: "Products",
  inventory: "Inventory",
  purchasing: "Purchasing & Suppliers",
  customers: "Customers",
  sales: "Sales & POS",
  reports: "Reports",
  financial: "Financial",
  expenses: "Expenses",
  admin: "Administration",
};

/** Mirrors set_role_permissions()'s (0054) own Owner-role invariant. */
const OWNER_REQUIRED_KEYS = new Set(["roles.manage", "business.manage"]);

/**
 * Checkbox grid for a role's permissions, grouped by the same categories
 * the platform catalog itself uses (permissions.category, seeded in
 * 0010). Posts one `permission` form value per checked box —
 * updateRolePermissions() reads them all via formData.getAll("permission").
 */
export function RolePermissionsForm({
  action,
  catalog,
  selectedKeys,
  isOwnerRole,
}: {
  action: (prevState: PermissionsFormState, formData: FormData) => Promise<PermissionsFormState>;
  catalog: PermissionCatalogEntry[];
  selectedKeys: string[];
  /** True only for the built-in Owner role — locks roles.manage/business.manage checked and disabled, matching set_role_permissions()'s server-side invariant. */
  isOwnerRole: boolean;
}) {
  const [state, formAction] = useFormState(action, initialState);
  const selected = new Set(selectedKeys);

  const byCategory = new Map<string, PermissionCatalogEntry[]>();
  for (const entry of catalog) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="rounded-xl bg-green-50 px-3.5 py-2.5 text-sm text-green-700 dark:bg-green-950/40 dark:text-green-300">
          Saved.
        </p>
      ) : null}

      {isOwnerRole ? (
        <p className="rounded-xl bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:bg-surface/60 dark:text-ink-muted">
          The Owner role always keeps &quot;Manage roles&quot; and &quot;Manage business settings&quot;, so a
          business can never lock itself out of its own settings.
        </p>
      ) : null}

      <div className="flex flex-col gap-6">
        {[...byCategory.entries()].map(([category, entries]) => (
          <fieldset key={category} className="flex flex-col gap-3">
            <legend className="text-sm font-semibold text-neutral-800 dark:text-ink">
              {CATEGORY_LABELS[category] ?? category}
            </legend>
            <div className="flex flex-col gap-2.5 sm:grid sm:grid-cols-2 sm:gap-x-6">
              {entries.map((entry) => {
                const locked = isOwnerRole && OWNER_REQUIRED_KEYS.has(entry.key);
                return (
                  <span key={entry.key}>
                    {/* A disabled checkbox never submits — the paired hidden
                        input is what actually posts the locked value. */}
                    <Checkbox
                      name={locked ? undefined : "permission"}
                      value={entry.key}
                      label={entry.description}
                      defaultChecked={selected.has(entry.key) || locked}
                      disabled={locked}
                    />
                    {locked ? <input type="hidden" name="permission" value={entry.key} /> : null}
                  </span>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      <SubmitButton pendingText="Saving…" className="self-start px-6">
        Save permissions
      </SubmitButton>
    </form>
  );
}