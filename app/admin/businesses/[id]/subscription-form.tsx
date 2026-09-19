"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/button";
import { updateBusinessSubscription, type SubscriptionFormState } from "./actions";

const initialState: SubscriptionFormState = {};

// Mirrors the `subscription_status` Postgres enum (0006) — kept in sync
// by hand, same as lib/entitlements/limits.ts's own copy of it.
const STATUS_OPTIONS = [
  { value: "trialing", label: "Trialing" },
  { value: "active", label: "Active" },
  { value: "past_due", label: "Past due (grace period)" },
  { value: "suspended", label: "Suspended" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
];

export function SubscriptionForm({
  businessId,
  plans,
  current,
}: {
  businessId: string;
  plans: { slug: string; name: string }[];
  current: { planSlug: string; status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean };
}) {
  const updateWithId = updateBusinessSubscription.bind(null, businessId);
  const [state, formAction] = useFormState(updateWithId, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="rounded-xl bg-green-50 px-3.5 py-2.5 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          Subscription updated.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select label="Plan" name="planSlug" required defaultValue={current.planSlug} options={plans.map((p) => ({ value: p.slug, label: p.name }))} />
        <Select label="Status" name="status" required defaultValue={current.status} options={STATUS_OPTIONS} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Current period ends"
          name="currentPeriodEnd"
          type="date"
          defaultValue={current.currentPeriodEnd ? current.currentPeriodEnd.slice(0, 10) : ""}
        />
        <label className="flex items-center gap-2 self-end pb-2.5 text-sm text-neutral-700 dark:text-ink">
          <input
            type="checkbox"
            name="cancelAtPeriodEnd"
            defaultChecked={current.cancelAtPeriodEnd}
            className="h-4 w-4 rounded border-neutral-300 text-lime-500 focus:ring-lime-400 dark:border-surface-line"
          />
          Cancel at period end
        </label>
      </div>

      <p className="text-sm text-neutral-500 dark:text-ink-muted">
        There is no automatic billing yet (Phase 18) — this is how a business is put on a paid plan after being paid
        some other way. Leaving &quot;Current period ends&quot; blank means no fixed end date.
      </p>

      <div className="flex justify-end">
        <SubmitButton pendingText="Saving…">Save subscription</SubmitButton>
      </div>
    </form>
  );
}