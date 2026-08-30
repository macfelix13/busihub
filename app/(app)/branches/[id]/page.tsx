import Link from "next/link";
import { notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { SetMainBranchButton } from "../set-main-branch-button";

export const metadata = { title: "Branch" };

function addressLabel(branch: {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
}): string {
  const lines = [branch.address_line1, branch.address_line2, [branch.city, branch.region].filter(Boolean).join(", ")].filter(
    (part) => part && part.trim().length > 0
  );
  return lines.length > 0 ? lines.join(", ") : "No address set";
}

export default async function BranchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.BRANCHES_MANAGE);

  // RLS-scoped: a branch id from another tenant simply won't be found here.
  const { data: branch, error } = await supabase
    .from("branches")
    .select("id, name, is_main, address_line1, address_line2, city, region, phone, email, timezone, status")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("BranchDetailPage: branch query failed", error);
  }

  if (!branch) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{branch.name}</h1>
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
          <p className="text-neutral-500">{addressLabel(branch)}</p>
        </div>
        <div className="flex items-center gap-2">
          {canManage ? (
            <Link href={`/branches/${branch.id}/edit`}>
              <Button variant="secondary">Edit</Button>
            </Link>
          ) : null}
          {canManage && !branch.is_main ? <SetMainBranchButton branchId={branch.id} /> : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <dl className="divide-y divide-neutral-100 dark:divide-neutral-800">
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">Phone</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">{branch.phone || "—"}</dd>
          </div>
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">Email</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">{branch.email || "—"}</dd>
          </div>
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">Address</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">
              {branch.address_line1 || "—"}
              {branch.address_line2 ? `, ${branch.address_line2}` : ""}
            </dd>
          </div>
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">City / Region</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">
              {[branch.city, branch.region].filter(Boolean).join(", ") || "—"}
            </dd>
          </div>
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">Timezone</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">{branch.timezone}</dd>
          </div>
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">Status</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">
              {branch.status === "active" ? "Active" : "Inactive"}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
