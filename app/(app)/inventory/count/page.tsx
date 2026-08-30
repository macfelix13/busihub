import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { StockForm } from "../stock-form";
import { loadStockFormData } from "../load-form-data";
import { recordStockCount } from "../actions";

export const metadata = { title: "Stock count" };

export default async function StockCountPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; variant?: string }>;
}) {
  const { branch, variant } = await searchParams;

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  // Cosmetic — recordStockCount() re-checks this server-side regardless.
  if (!(await hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_ADJUST))) {
    redirect("/inventory");
  }

  const { branch: activeBranch, variants, quantities } = await loadStockFormData(branch);

  if (!activeBranch) {
    redirect("/inventory");
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Stock count</h1>
        <p className="text-neutral-500">Record what is physically on the shelf.</p>
      </div>
      <StockForm
        mode="count"
        action={recordStockCount}
        branchId={activeBranch.id}
        branchName={activeBranch.name}
        variants={variants}
        quantities={quantities}
        defaultVariantId={variant}
      />
    </div>
  );
}
