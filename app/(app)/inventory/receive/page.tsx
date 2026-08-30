import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { StockForm } from "../stock-form";
import { loadStockFormData } from "../load-form-data";
import { receiveStock } from "../actions";

export const metadata = { title: "Receive stock" };

export default async function ReceiveStockPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; variant?: string }>;
}) {
  const { branch, variant } = await searchParams;

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  // Cosmetic — receiveStock() re-checks this server-side regardless.
  if (!(await hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_RECEIVE))) {
    redirect("/inventory");
  }

  const { branch: activeBranch, variants, quantities } = await loadStockFormData(branch);

  if (!activeBranch) {
    redirect("/inventory");
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Receive stock</h1>
        <p className="text-neutral-500">Record stock arriving at a branch.</p>
      </div>
      <StockForm
        mode="receive"
        action={receiveStock}
        branchId={activeBranch.id}
        branchName={activeBranch.name}
        variants={variants}
        quantities={quantities}
        defaultVariantId={variant}
      />
    </div>
  );
}
