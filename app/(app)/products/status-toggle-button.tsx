"use client";

import { SubmitButton } from "@/components/ui/button";

/** Wraps a bound plain (no-useFormState) status-change action as a one-button form — same pattern as branches/set-main-branch-button.tsx. */
export function StatusToggleButton({
  action,
  label,
  pendingLabel,
  variant = "secondary",
}: {
  action: () => Promise<void>;
  label: string;
  pendingLabel: string;
  variant?: "secondary" | "danger" | "ghost";
}) {
  return (
    <form action={action}>
      <SubmitButton variant={variant} pendingText={pendingLabel}>
        {label}
      </SubmitButton>
    </form>
  );
}

