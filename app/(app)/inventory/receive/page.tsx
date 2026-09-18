import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { PageHeader } from "@/components/ui/page-header";
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

  // Cosmetic — receiveStock() only reads/stores the expiry date, it
  // doesn't gate on this setting. A shop that hasn't turned tracking on
  // just doesn't get asked for it.
  const { data: settings } = await supabase
    .from("business_settings")
    .select("inventory_settings")
    .eq("business_id", businessId)
    .maybeSingle();
  const trackExpiry = Boolean((settings?.inventory_settings as { track_expiry?: boolean } | null)?.track_expiry);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Receive stock" description="Record stock arriving at a branch." />
      <StockForm
        mode="receive"
        action={receiveStock}
        branchId={activeBranch.id}
        branchName={activeBranch.name}
        variants={variants}
        quantities={quantities}
        defaultVariantId={variant}
        trackExpiry={trackExpiry}
      />
    </div>
  );
}