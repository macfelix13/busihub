"use client";

import { useFormState } from "react-dom";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/button";
import { changeStaffRole, type RoleFormState } from "../actions";

const initialState: RoleFormState = {};

export function RoleAssignmentForm({
  userId,
  branchId,
  branchName,
  currentRoleId,
  roles,
}: {
  userId: string;
  branchId: string;
  branchName: string;
  currentRoleId: string | null;
  roles: { id: string; name: string }[];
}) {
  const [state, formAction] = useFormState(changeStaffRole, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="branchId" value={branchId} />
      <div className="flex-1">
        <Select
          label={branchName}
          name="roleId"
          defaultValue={currentRoleId ?? ""}
          options={[{ value: "", label: "No access at this branch" }, ...roles.map((r) => ({ value: r.id, label: r.name }))]}
        />
      </div>
      <SubmitButton variant="secondary" pendingText="Saving…">
        Save
      </SubmitButton>
      {state.error ? (
        <p role="alert" className="w-full text-sm text-red-600 dark:text-red-400 sm:basis-full">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="w-full text-sm text-green-600 dark:text-green-400 sm:basis-full">
          Saved.
        </p>
      ) : null}
    </form>
  );
}