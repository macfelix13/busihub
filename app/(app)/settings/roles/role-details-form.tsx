"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/button";
import type { FormState } from "./actions";

const initialState: FormState = {};

export interface RoleDetailsDefaults {
  name: string;
  description: string;
}

/**
 * Create/edit form for a role's name and description — permissions live
 * in their own form (role-permissions-form.tsx) so saving one never
 * risks clobbering the other.
 */
export function RoleDetailsForm({
  action,
  defaultValues,
  submitLabel,
  nameLocked = false,
}: {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  defaultValues?: RoleDetailsDefaults;
  submitLabel: string;
  /**
   * True for a built-in role. The name field is rendered read-only
   * (not disabled — a disabled input never submits, which would make the
   * server action see no `name` value at all) so it still posts its
   * current value; updateRoleDetails() ignores that value for a system
   * role regardless, and protect_system_role_identity() (0054) is the
   * real, database-level backstop either way.
   */
  nameLocked?: boolean;
}) {
  const [state, formAction] = useFormState(action, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Field
          label="Role name"
          name="name"
          required
          defaultValue={defaultValues?.name}
          error={state.fieldErrors?.name}
          readOnly={nameLocked}
          className={nameLocked ? "cursor-not-allowed opacity-70" : undefined}
        />
        {nameLocked ? (
          <p className="text-sm text-neutral-500 dark:text-ink-muted">Built-in role names can&apos;t be changed.</p>
        ) : null}
      </div>

      <Textarea
        label="Description (optional)"
        name="description"
        defaultValue={defaultValues?.description}
        error={state.fieldErrors?.description}
      />

      <SubmitButton pendingText="Saving…" className="self-start px-6">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}