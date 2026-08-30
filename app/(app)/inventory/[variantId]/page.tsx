import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { formatQuantity } from "@/lib/validation/inventory";

export const metadata = { title: "Stock history" };

const REASON_LABELS: Record<string, string> = {
  receive: "Received",
  adjustment: "Adjustment",
  stock_count: "Stock count",
  sale: "Sale",
  sale_refund: "Refund",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
};

interface MovementRow {
  id: string;
  quantity_delta: number | string;
  reason: string;
  note: string | null;
  created_at: string;
  branch_id: string;
  branches: { name: string } | null;
  profiles: { first_name: string | null; last_name: string | null } | null;
}

export default async function VariantStockHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ variantId: string }>;
  searchParams: Promise<{ branch?: string }>;
}) {
  const { variantId } = await params;
  const { branch } = await searchParams;

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canView, canReceive, canAdjust] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_VIEW),
    hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_RECEIVE),
    hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_ADJUST),
  ]);

  if (!canView) {
    redirect("/dashboard");
  }

  // RLS-scoped: another tenant's variant id simply isn't found.
  const { data: variant, error: variantError } = await supabase
    .from("product_variants")
    .select("id, sku, variant_options, products!inner(id, name, unit_of_measure)")
    .eq("id", variantId)
    .maybeSingle();

  if (variantError) {
    console.error("VariantStockHistoryPage: variant query failed", variantError);
  }

  if (!variant) {
    notFound();
  }

  const product = (variant as unknown as { products: { id: string; name: string; unit_of_measure: string } }).products;
  const options = Object.entries((variant.variant_options ?? {}) as Record<string, string>);

  const [{ data: levels, error: levelsError }, { data: movements, error: movementsError }] = await Promise.all([
    supabase.from("stock_levels").select("branch_id, quantity, branches(name)").eq("variant_id", variantId),
    supabase
      .from("inventory_movements")
      .select("id, quantity_delta, reason, note, created_at, branch_id, branches(name), profiles:created_by(first_name, last_name)")
      .eq("variant_id", variantId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (levelsError) console.error("VariantStockHistoryPage: levels query failed", levelsError);
  if (movementsError) console.error("VariantStockHistoryPage: movements query failed", movementsError);

  const levelRows = (levels ?? []) as unknown as {
    branch_id: string;
    quantity: number | string;
    branches: { name: string } | null;
  }[];
  const total = levelRows.reduce((sum, l) => sum + Number(l.quantity), 0);
  const backBranch = branch ?? levelRows[0]?.branch_id;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{product.name}</h1>
          <p className="text-neutral-500">
            {options.length > 0 ? `${options.map(([k, v]) => `${k}: ${v}`).join(", ")} · ` : ""}
            {variant.sku || "No SKU"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canReceive ? (
            <Link href={`/inventory/receive?variant=${variant.id}${backBranch ? `&branch=${backBranch}` : ""}`}>
              <Button variant="secondary">Receive</Button>
            </Link>
          ) : null}
          {canAdjust ? (
            <Link href={`/inventory/adjust?variant=${variant.id}${backBranch ? `&branch=${backBranch}` : ""}`}>
              <Button variant="secondary">Adjust</Button>
            </Link>
          ) : null}
        </div>
      </div>

      <div>
        <h2 className="font-semibold">On hand</h2>
        <div className="mt-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {levelRows.length > 0 ? (
              <>
                {levelRows.map((level) => (
                  <li key={level.branch_id} className="flex items-center justify-between px-5 py-3 text-sm">
                    <span>{level.branches?.name ?? "Unknown branch"}</span>
                    <span className="font-medium tabular-nums">
                      {formatQuantity(level.quantity)}{" "}
                      <span className="text-xs font-normal text-neutral-500">{product.unit_of_measure}</span>
                    </span>
                  </li>
                ))}
                {levelRows.length > 1 ? (
                  <li className="flex items-center justify-between bg-neutral-50 px-5 py-3 text-sm font-medium dark:bg-neutral-800/50">
                    <span>Total across branches</span>
                    <span className="tabular-nums">
                      {formatQuantity(total)}{" "}
                      <span className="text-xs font-normal text-neutral-500">{product.unit_of_measure}</span>
                    </span>
                  </li>
                ) : null}
              </>
            ) : (
              <li className="px-5 py-6 text-center text-sm text-neutral-500">No stock recorded yet.</li>
            )}
          </ul>
        </div>
      </div>

      <div>
        <h2 className="font-semibold">Movement history</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Every change to this item&apos;s stock, most recent first. Entries are never edited or deleted — a correction is
          a new entry.
        </p>
        <div className="mt-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase text-neutral-500 dark:border-neutral-800">
                <tr>
                  <th className="px-4 py-3 font-medium">When</th>
                  <th className="px-4 py-3 font-medium">Branch</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 text-right font-medium">Change</th>
                  <th className="px-4 py-3 font-medium">Note</th>
                  <th className="px-4 py-3 font-medium">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {movements && movements.length > 0 ? (
                  (movements as unknown as MovementRow[]).map((m) => {
                    const delta = Number(m.quantity_delta);
                    const who = [m.profiles?.first_name, m.profiles?.last_name].filter(Boolean).join(" ");
                    return (
                      <tr key={m.id}>
                        <td className="px-4 py-3 text-neutral-500">
                          {new Date(m.created_at).toLocaleString("en-GB", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                        <td className="px-4 py-3">{m.branches?.name ?? "—"}</td>
                        <td className="px-4 py-3">{REASON_LABELS[m.reason] ?? m.reason}</td>
                        <td
                          className={`px-4 py-3 text-right font-medium tabular-nums ${
                            delta > 0 ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"
                          }`}
                        >
                          {delta > 0 ? "+" : ""}
                          {formatQuantity(delta)}
                        </td>
                        <td className="px-4 py-3 text-neutral-500">{m.note || "—"}</td>
                        <td className="px-4 py-3 text-neutral-500">{who || "—"}</td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-neutral-500">
                      No movements recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
