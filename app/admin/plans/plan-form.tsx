"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/button";
import { upsertSubscriptionPlan, type PlanFormState } from "./actions";
import type { PlanLimits } from "@/lib/entitlements/limits";

const initialState: PlanFormState = {};

const BILLING_INTERVAL_OPTIONS = [
  { value: "month", label: "Monthly" },
  { value: "year", label: "Yearly" },
  { value: "none", label: "One-time / free (no recurring charge)" },
];

const NUMERIC_LIMIT_FIELDS: { key: keyof Omit<PlanLimits, "features">; label: string }[] = [
  { key: "max_branches", label: "Max branches" },
  { key: "max_users", label: "Max staff accounts" },
  { key: "max_products", label: "Max products" },
  { key: "max_pos_terminals", label: "Max POS terminals" },
  { key: "storage_mb", label: "Storage (MB)" },
];

const FEATURE_FIELDS: { key: keyof PlanLimits["features"]; label: string }[] = [
  { key: "advanced_reports", label: "Advanced reports" },
  { key: "api_access", label: "API access" },
  { key: "sms_notifications", label: "SMS notifications" },
];

export interface PlanFormValues {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceAmount: string;
  currencyCode: string;
  billingInterval: string;
  limits: PlanLimits;
  isActive: boolean;
  sortOrder: number;
}

/**
 * Shared by both /admin/plans/new (plan=null) and /admin/plans/[id]
 * (plan=the existing row) — same "one form component, bound to a
 * different id" shape as SubscriptionForm (app/admin/businesses/[id]/subscription-form.tsx).
 * Every real validation happens inside admin_upsert_subscription_plan()
 * itself (0059); this form only collects the fields and leaves each
 * numeric limit blank to mean "unlimited" (Enterprise's own convention,
 * see 0010's seed data comment) rather than asking for a literal "null".
 */
export function PlanForm({ plan }: { plan?: PlanFormValues }) {
  const upsertWithId = upsertSubscriptionPlan.bind(null, plan?.id ?? null);
  const [state, formAction] = useFormState(upsertWithId, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" name="name" required defaultValue={plan?.name} placeholder="e.g. Growth" />
        <Field
          label="Slug"
          name="slug"
          required
          defaultValue={plan?.slug}
          placeholder="e.g. growth"
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          title="Lowercase letters, numbers, and hyphens only"
        />
      </div>

      <Textarea
        label="Description"
        name="description"
        defaultValue={plan?.description ?? ""}
        placeholder="Shown to Super Admin only — not customer-facing yet."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field
          label="Price"
          name="priceAmount"
          type="number"
          min="0"
          step="0.01"
          required
          defaultValue={plan?.priceAmount ?? "0"}
        />
        <Field label="Currency" name="currencyCode" required defaultValue={plan?.currencyCode ?? "GHS"} maxLength={3} />
        <Select
          label="Billing interval"
          name="billingInterval"
          required
          defaultValue={plan?.billingInterval ?? "month"}
          options={BILLING_INTERVAL_OPTIONS}
        />
      </div>

      <div>
        <h3 className="text-sm font-medium text-neutral-800 dark:text-ink">Limits</h3>
        <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
          Leave a field blank for unlimited. Only max branches, max staff accounts, and max products are actually
          enforced right now (see Settings → Billing on any business, or docs/ARCHITECTURE.md Section 9) — max POS
          terminals and storage are stored for later but nothing counts against them yet.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {NUMERIC_LIMIT_FIELDS.map(({ key, label }) => (
            <Field
              key={key}
              label={label}
              name={`limit_${key}`}
              type="number"
              min="0"
              step="1"
              placeholder="Unlimited"
              defaultValue={plan?.limits[key] ?? ""}
            />
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-neutral-800 dark:text-ink">Feature flags</h3>
        <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
          Stored for later — none of these gates anything in the app yet (see docs/ARCHITECTURE.md Section 9).
        </p>
        <div className="mt-3 flex flex-col gap-3">
          {FEATURE_FIELDS.map(({ key, label }) => (
            <Checkbox
              key={key}
              label={label}
              name={`feature_${key}`}
              defaultChecked={plan?.limits.features[key] ?? false}
            />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Sort order"
          name="sortOrder"
          type="number"
          step="1"
          defaultValue={plan?.sortOrder ?? 0}
        />
        <Checkbox
          label="Active"
          description="Only active plans can be assigned to a business, or shown as a choice anywhere else."
          name="isActive"
          defaultChecked={plan?.isActive ?? true}
        />
      </div>

      <div className="flex justify-end">
        <SubmitButton pendingText="Saving…">{plan ? "Save plan" : "Create plan"}</SubmitButton>
      </div>
    </form>
  );
}