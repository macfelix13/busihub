"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/button";
import { inviteStaff, type InviteFormState } from "../actions";

const initialState: InviteFormState = {};

export function InviteStaffForm({
  branches,
  roles,
}: {
  branches: { id: string; name: string }[];
  roles: { id: string; name: string; description: string | null }[];
}) {
  const [state, formAction] = useFormState(inviteStaff, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="First name" name="firstName" required error={state.fieldErrors?.firstName} />
        <Field label="Last name" name="lastName" error={state.fieldErrors?.lastName} />
      </div>

      <Field
        label="Email"
        name="email"
        type="email"
        required
        placeholder="colleague@example.com"
        error={state.fieldErrors?.email}
      />
      <p className="-mt-2 text-sm text-neutral-500">
        We&apos;ll send them an email with a link to set their own password. No account is created until they do.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Branch"
          name="branchId"
          required
          error={state.fieldErrors?.branchId}
          options={branches.map((b) => ({ value: b.id, label: b.name }))}
        />
        <Select
          label="Role"
          name="roleId"
          required
          error={state.fieldErrors?.roleId}
          options={roles.map((r) => ({ value: r.id, label: r.name }))}
        />
      </div>
      <p className="-mt-2 text-sm text-neutral-500">
        Most roles apply across every branch — the branch here mainly matters for till/cashier assignments. You can
        change this later from the staff list.
      </p>

      <SubmitButton pendingText="Sending invite…" className="mt-2 self-start px-6">
        Send invite
      </SubmitButton>
    </form>
  );
}