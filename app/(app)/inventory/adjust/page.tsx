import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { PageHeader } from "@/components/ui/page-header";
import { StockForm } from "../stock-form";
import { loadStockFormData } from "../load-form-data";
import { adjustStock } from "../actions";

export const metadata = { title: "Adjust stock" };

export default async function AdjustStockPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; variant?: string }>;
}) {
  const { branch, variant } = await searchParams;

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  // Cosmetic — adjustStock() re-checks this server-side regardless.
  if (!(await hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_ADJUST))) {
    redirect("/inventory");
  }

  const { branch: activeBranch, variants, quantities } = await loadStockFormData(branch);

  if (!activeBranch) {
    redirect("/inventory");
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Adjust stock" description="Correct the stock on hand, with a reason for the record." />
      <StockForm
        mode="adjust"
        action={adjustStock}
        branchId={activeBranch.id}
        branchName={activeBranch.name}
        variants={variants}
        quantities={quantities}
        defaultVariantId={variant}
      />
    </div>
  );
}