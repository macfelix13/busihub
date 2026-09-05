import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { SetMainBranchButton } from "./set-main-branch-button";

export const metadata = { title: "Branches" };

export default async function BranchesPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.BRANCHES_MANAGE);

  // RLS-scoped — no explicit .eq("business_id", ...) needed (Section 4, Section 49).
  const { data: branches, error } = await supabase
    .from("branches")
    .select("id, name, is_main, city, region, phone, email, status")
    .order("is_main", { ascending: false })
    .order("name", { ascending: true });

  if (error) {
    console.error("BranchesPage: branches query failed", error);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Branches</h1>
          <p className="text-neutral-500">Locations your business operates from.</p>
        </div>
        {canManage ? (
          <Link href="/branches/new">
            <Button>Add branch</Button>
          </Link>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load branches. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {branches && branches.length > 0 ? (
              branches.map((branch) => (
                <li key={branch.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <Link href={`/branches/${branch.id}`} className="flex-1 rounded-lg hover:opacity-80">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{branch.name}</span>
                      {branch.is_main ? (
                        <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-800 dark:bg-brand-900 dark:text-brand-200">
                          Main
                        </span>
                      ) : null}
                      {branch.status === "inactive" ? (
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                          Inactive
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-sm text-neutral-500">
                      {[branch.city, branch.region].filter(Boolean).join(", ") || "No location set"}
                      {branch.phone ? ` · ${branch.phone}` : ""}
                    </p>
                  </Link>
                  {canManage ? (
                    <div className="flex items-center gap-2">
                      {!branch.is_main ? <SetMainBranchButton branchId={branch.id} /> : null}
                      <Link href={`/branches/${branch.id}/edit`}>
                        <Button variant="secondary">Edit</Button>
                      </Link>
                    </div>
                  ) : null}
                </li>
              ))
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500">No branches yet.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}