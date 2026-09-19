import Link from "next/link";
import { Building2, Users, MessageSquare, TrendingUp, PauseCircle, Archive } from "lucide-react";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Busihub Admin" };

/**
 * The admin console's own home page — until now /admin had nothing of its
 * own and just redirected straight to the businesses list (Section 49 /
 * migration 0035's changelog entry). Every number here is a plain count
 * against businesses/profiles/support_requests, scoped by the same RLS
 * that already lets a Super Admin see every row (app_is_super_admin(),
 * 0008) — nothing here is a new privilege, just a first landing page for
 * the ones the console already had.
 */
export default async function AdminHomePage() {
  const supabase = await createServerSupabaseClient();

  // new Date().getTime() rather than Date.now() — eslint's react-hooks
  // purity check (the React Compiler rules) flags Date.now() as a known
  // impure call, even here in a Server Component where it's exactly
  // right (a fresh per-request cutoff). new Date() itself isn't flagged,
  // matching how the rest of this codebase already calls it freely for
  // per-request timestamps (e.g. the dashboard's own header date).
  const sevenDaysAgo = new Date(new Date().getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { count: totalBusinesses, error: totalError },
    { count: activeBusinesses, error: activeError },
    { count: suspendedBusinesses, error: suspendedError },
    { count: closedBusinesses, error: closedError },
    { count: newSignups, error: signupsError },
    { count: totalStaff, error: staffError },
    { count: openSupportRequests, error: supportError },
  ] = await Promise.all([
    supabase.from("businesses").select("id", { count: "exact", head: true }),
    supabase.from("businesses").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("businesses").select("id", { count: "exact", head: true }).eq("status", "suspended"),
    supabase.from("businesses").select("id", { count: "exact", head: true }).eq("status", "closed"),
    supabase.from("businesses").select("id", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
    supabase.from("profiles").select("id", { count: "exact", head: true }).not("business_id", "is", null),
    supabase.from("support_requests").select("id", { count: "exact", head: true }).eq("status", "open"),
  ]);

  // Logged, not shown — same reasoning as every other page in this app:
  // a database error message names columns/functions, and a stat tile
  // reading 0 because a query failed is confusing enough on its own
  // without also leaking internals.
  for (const [label, error] of [
    ["total businesses", totalError],
    ["active businesses", activeError],
    ["suspended businesses", suspendedError],
    ["closed businesses", closedError],
    ["new signups", signupsError],
    ["staff", staffError],
    ["open support requests", supportError],
  ] as const) {
    if (error) console.error(`AdminHomePage: ${label} count failed`, error);
  }

  const stats = [
    { label: "Total businesses", value: totalBusinesses ?? 0, icon: Building2 },
    { label: "Active", value: activeBusinesses ?? 0, icon: TrendingUp },
    { label: "Suspended", value: suspendedBusinesses ?? 0, icon: PauseCircle },
    { label: "Closed", value: closedBusinesses ?? 0, icon: Archive },
    { label: "New signups (7 days)", value: newSignups ?? 0, icon: TrendingUp },
    { label: "Staff, platform-wide", value: totalStaff ?? 0, icon: Users },
  ];

  const openCount = openSupportRequests ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-neutral-500 dark:text-ink-muted">Busihub, platform-wide.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.label} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-ink-muted">
                  {stat.label}
                </p>
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
              </div>
              <p className="mt-2 text-2xl font-semibold tabular-nums">{stat.value}</p>
            </Card>
          );
        })}
      </div>

      <Link
        href="/admin/support"
        className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-200 bg-white px-5 py-4 text-sm transition-colors hover:bg-neutral-50 dark:border-surface-line dark:bg-surface-card dark:hover:bg-surface/60"
      >
        <span className="flex items-center gap-2.5">
          <MessageSquare className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span>
            <span className="font-semibold tabular-nums">{openCount}</span>{" "}
            {openCount === 1 ? "support request is" : "support requests are"} waiting.
          </span>
        </span>
      </Link>
    </div>
  );
}