import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatQuantity } from "@/lib/validation/inventory";
import { StatusToggleButton } from "@/app/(app)/products/status-toggle-button";
import { ExpiryBatchForm } from "./expiry-batch-form";
import { addExpiryBatch, deleteExpiryBatch } from "../actions";

export const metadata = { title: "Stock history" };

interface BatchRow {
  id: string;
  branch_id: string;
  quantity: number | string;
  expiry_date: string;
  note: string | null;
  branches: { name: string } | null;
}

function daysUntil(expiryDate: string): number {
  // Both sides at UTC midnight so "today" reads as 0 regardless of the
  // server's local offset — an expiry_date is a plain date, not a
  // timestamp, and shouldn't shift by a day depending on where this runs.
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const expiry = new Date(expiryDate + "T00:00:00Z").getTime();
  return Math.round((expiry - todayUtc) / (24 * 60 * 60 * 1000));
}

function expiryLabel(days: number): { text: string; className: string } {
  if (days < 0) {
    return {
      text: `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`,
      className: "text-red-600 dark:text-red-400",
    };
  }
  if (days === 0) {
    return { text: "Expires today", className: "text-red-600 dark:text-red-400" };
  }
  if (days <= 7) {
    return { text: `Expires in ${days} day${days === 1 ? "" : "s"}`, className: "text-amber-600 dark:text-amber-400" };
  }
  return { text: `Expires in ${days} days`, className: "text-neutral-500 dark:text-ink-muted" };
}

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

  const [
    { data: levels, error: levelsError },
    { data: movements, error: movementsError },
    { data: settings },
    { data: batchRows, error: batchesError },
  ] = await Promise.all([
    supabase.from("stock_levels").select("branch_id, quantity, branches(name)").eq("variant_id", variantId),
    supabase
      .from("inventory_movements")
      .select("id, quantity_delta, reason, note, created_at, branch_id, branches(name), profiles:created_by(first_name, last_name)")
      .eq("variant_id", variantId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("business_settings").select("inventory_settings").eq("business_id", businessId).maybeSingle(),
    supabase
      .from("stock_batches")
      .select("id, branch_id, quantity, expiry_date, note, branches(name)")
      .eq("variant_id", variantId)
      .order("expiry_date", { ascending: true }),
  ]);

  if (levelsError) console.error("VariantStockHistoryPage: levels query failed", levelsError);
  if (movementsError) console.error("VariantStockHistoryPage: movements query failed", movementsError);
  if (batchesError) console.error("VariantStockHistoryPage: batches query failed", batchesError);

  const trackExpiry = Boolean((settings?.inventory_settings as { track_expiry?: boolean } | null)?.track_expiry);
  const batches = (batchRows ?? []) as unknown as BatchRow[];

  const levelRows = (levels ?? []) as unknown as {
    branch_id: string;
    quantity: number | string;
    branches: { name: string } | null;
  }[];
  const total = levelRows.reduce((sum, l) => sum + Number(l.quantity), 0);
  const backBranch = branch ?? levelRows[0]?.branch_id;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={product.name}
        description={`${options.length > 0 ? `${options.map(([k, v]) => `${k}: ${v}`).join(", ")} · ` : ""}${
          variant.sku || "No SKU"
        }`}
        actions={
          <>
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
          </>
        }
      />

      <div>
        <h2 className="font-semibold">On hand</h2>
        <Card className="mt-3 overflow-hidden">
          <ul className="divide-y divide-neutral-100 dark:divide-surface-line">
            {levelRows.length > 0 ? (
              <>
                {levelRows.map((level) => (
                  <li key={level.branch_id} className="flex items-center justify-between px-5 py-3 text-sm">
                    <span>{level.branches?.name ?? "Unknown branch"}</span>
                    <span className="font-medium tabular-nums">
                      {formatQuantity(level.quantity)}{" "}
                      <span className="text-xs font-normal text-neutral-500 dark:text-ink-muted">{product.unit_of_measure}</span>
                    </span>
                  </li>
                ))}
                {levelRows.length > 1 ? (
                  <li className="flex items-center justify-between bg-neutral-50 px-5 py-3 text-sm font-medium dark:bg-surface/60">
                    <span>Total across branches</span>
                    <span className="tabular-nums">
                      {formatQuantity(total)}{" "}
                      <span className="text-xs font-normal text-neutral-500 dark:text-ink-muted">{product.unit_of_measure}</span>
                    </span>
                  </li>
                ) : null}
              </>
            ) : (
              <li className="px-5 py-6 text-center text-sm text-neutral-500 dark:text-ink-muted">No stock recorded yet.</li>
            )}
          </ul>
        </Card>
      </div>

      {trackExpiry || batches.length > 0 ? (
        <div>
          <h2 className="font-semibold">Expiry dates</h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
            Informational only — this tracks when a logged quantity expires, not how much of it is still unsold.
            Cross-check against &quot;On hand&quot; above before acting on it.
          </p>
          <Card className="mt-3 overflow-hidden">
            <ul className="divide-y divide-neutral-100 dark:divide-surface-line">
              {batches.length > 0 ? (
                batches.map((b) => {
                  const days = daysUntil(b.expiry_date);
                  const label = expiryLabel(days);
                  return (
                    <li key={b.id} className="flex flex-col gap-1 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {formatQuantity(b.quantity)} {product.unit_of_measure}
                          </span>
                          <span className="text-neutral-500 dark:text-ink-muted">— {b.branches?.name ?? "Unknown branch"}</span>
                        </div>
                        <p className={label.className}>{label.text}</p>
                        {b.note ? <p className="text-neutral-500 dark:text-ink-muted">{b.note}</p> : null}
                      </div>
                      {canAdjust ? (
                        <StatusToggleButton
                          action={deleteExpiryBatch.bind(null, b.id, variantId)}
                          label="Remove"
                          pendingLabel="Removing…"
                          variant="ghost"
                          confirm={{ title: "Remove this entry?", description: "This can't be undone.", confirmLabel: "Remove" }}
                        />
                      ) : null}
                    </li>
                  );
                })
              ) : (
                <li className="px-5 py-6 text-center text-sm text-neutral-500 dark:text-ink-muted">
                  No expiry dates logged yet.
                </li>
              )}
            </ul>
            {canReceive && trackExpiry ? (
              <div className="border-t border-neutral-200 p-5 dark:border-surface-line">
                <ExpiryBatchForm
                  action={addExpiryBatch}
                  variantId={variantId}
                  branches={levelRows.map((l) => ({ id: l.branch_id, name: l.branches?.name ?? "Unknown branch" }))}
                />
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      <div>
        <h2 className="font-semibold">Movement history</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
          Every change to this item&apos;s stock, most recent first. Entries are never edited or deleted — a correction is
          a new entry.
        </p>
        <Card className="mt-3 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase text-neutral-500 dark:text-ink-muted dark:border-surface-line">
                <tr>
                  <th className="px-4 py-3 font-medium">When</th>
                  <th className="px-4 py-3 font-medium">Branch</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 text-right font-medium">Change</th>
                  <th className="px-4 py-3 font-medium">Note</th>
                  <th className="px-4 py-3 font-medium">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-surface-line">
                {movements && movements.length > 0 ? (
                  (movements as unknown as MovementRow[]).map((m) => {
                    const delta = Number(m.quantity_delta);
                    const who = [m.profiles?.first_name, m.profiles?.last_name].filter(Boolean).join(" ");
                    return (
                      <tr key={m.id} className="transition-colors hover:bg-neutral-50 dark:hover:bg-surface/60">
                        <td className="px-4 py-3 text-neutral-500 dark:text-ink-muted">
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
                        <td className="px-4 py-3 text-neutral-500 dark:text-ink-muted">{m.note || "—"}</td>
                        <td className="px-4 py-3 text-neutral-500 dark:text-ink-muted">{who || "—"}</td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-neutral-500 dark:text-ink-muted">
                      No movements recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}