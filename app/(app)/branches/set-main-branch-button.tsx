"use client";

import { setMainBranch } from "./actions";
import { SubmitButton } from "@/components/ui/button";

export function SetMainBranchButton({ branchId }: { branchId: string }) {
  return (
    <form action={setMainBranch.bind(null, branchId)}>
      <SubmitButton variant="ghost" pendingText="Setting…">
        Set as main
      </SubmitButton>
    </form>
  );
}
