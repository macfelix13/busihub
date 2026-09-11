"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/button";
import { SUPPORTED_TIMEZONES, type BranchInput } from "@/lib/validation/branches";
import type { BranchFormState } from "./actions";

interface BranchFormProps {
  action: (prevState: BranchFormState, formData: FormData) => Promise<BranchFormState>;
  defaultValues?: Partial<BranchInput>;
  submitLabel: string;
  pendingLabel: string;
  showStatus?: boolean;
}

const initialState: BranchFormState = {};

/** Shared by app/(app)/branches/new and .../[id]/edit — same fields, different bound action. */
export function BranchForm({ action, defaultValues, submitLabel, pendingLabel, showStatus }: BranchFormProps) {
  const [state, formAction] = useFormState(action, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <Field
        label="Branch name"
        name="name"
        required
        defaultValue={defaultValues?.name}
        error={state.fieldErrors?.name}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Address line 1" name="addressLine1" defaultValue={defaultValues?.addressLine1} error={state.fieldErrors?.addressLine1} />
        <Field label="Address line 2" name="addressLine2" defaultValue={defaultValues?.addressLine2} error={state.fieldErrors?.addressLine2} />
        <Field label="City" name="city" defaultValue={defaultValues?.city} error={state.fieldErrors?.city} />
        <Field label="Region" name="region" defaultValue={defaultValues?.region} error={state.fieldErrors?.region} />
        <Field label="Phone" name="phone" type="tel" defaultValue={defaultValues?.phone} error={state.fieldErrors?.phone} />
        <Field label="Email" name="email" type="email" defaultValue={defaultValues?.email} error={state.fieldErrors?.email} />
      </div>

      <Select
        label="Timezone"
        name="timezone"
        defaultValue={defaultValues?.timezone ?? "Africa/Accra"}
        error={state.fieldErrors?.timezone}
        options={SUPPORTED_TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
      />

      {showStatus ? (
        <Select
          label="Status"
          name="status"
          defaultValue={defaultValues?.status ?? "active"}
          error={state.fieldErrors?.status}
          options={[
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ]}
        />
      ) : (
        <input type="hidden" name="status" value="active" />
      )}

      <SubmitButton pendingText={pendingLabel} className="mt-2 self-start px-6">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}
