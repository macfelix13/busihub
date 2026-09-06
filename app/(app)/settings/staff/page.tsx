import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Staff" };

const PAGE_SIZE = 50;

type ProfileStatus = "active" | "inactive" | "suspended";

interface StaffRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  status: ProfileStatus;
  last_login_at: string | null;
  created_at: string;
}

interface RoleAssignmentRow {
  user_id: string;
  roles: { name: string } | null;
  branches: { name: string } | null;
}

const STATUS_BADGE: Record<ProfileStatus, string> = {
  active: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  inactive: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  suspended: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const { q, status, page } = await searchParams;
  const activeStatus: ProfileStatus | "all" = status === "inactive" || status === "all" ? status : "active";
  const pageNumber = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManageUsers = await hasPermission(supabase, businessId, PERMISSIONS.USERS_MANAGE);

  // Cosmetic — every action on the detail page re-checks this (Section 49).
  if (!canManageUsers) {
    redirect("/dashboard");
  }

  const {
    data: { user: viewer },
  } = await supabase.auth.getUser();

  let query = supabase
    .from("profiles")
    .select("id, first_name, last_name, email, status, last_login_at, created_at", { count: "exact" })
    .eq("business_id", businessId)
    .order("created_at", { ascending: true })
    .range((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE - 1);

  if (activeStatus !== "all") {
    query = query.eq("status", activeStatus);
  }
  if (q && q.trim().length > 0) {
    const term = q.trim().replace(/[%,]/g, "");
    query = query.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%`);
  }

  const { data: staffRows, error, count } = await query;
  if (error) {
    console.error("StaffPage: profiles query failed", error);
  }

  const staff = (staffRows ?? []) as StaffRow[];
  const staffIds = staff.map((s) => s.id);

  const { data: roleRows, error: roleError } =
    staffIds.length > 0
      ? await supabase.from("user_branch_roles").select("user_id, roles(name), branches(name)").in("user_id", staffIds)
      : { data: [] as RoleAssignmentRow[], error: null };

  if (roleError) {
    console.error("StaffPage: roles query failed", roleError);
  }

  const rolesByUser = new Map<string, string[]>();
  for (const row of (roleRows ?? []) as unknown as RoleAssignmentRow[]) {
    if (!row.roles?.name) continue;
    const label = row.branches?.name ? `${row.roles.name} · ${row.branches.name}` : row.roles.name;
    const list = rolesByUser.get(row.user_id) ?? [];
    list.push(label);
    rolesByUser.set(row.user_id, list);
  }

  const totalCount = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageQuery = (overrides: Record<string, string>) => ({
    ...(q ? { q } : {}),
    ...(activeStatus !== "active" ? { status: activeStatus } : {}),
    ...overrides,
  });

  const tabClass = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${
      active ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
    }`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Staff</h1>
          <p className="text-neutral-500">Everyone with access to your Busihub account, {totalCount} total.</p>
        </div>
        <Link href="/settings/staff/new" className="flex-shrink-0">
          <Button>Invite staff</Button>
        </Link>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1 rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
          {(["active", "inactive", "all"] as const).map((option) => (
            <Link
              key={option}
              href={{ pathname: "/settings/staff", query: { ...(q ? { q } : {}), status: option } }}
              className={tabClass(activeStatus === option)}
            >
              {option === "all" ? "All" : option.charAt(0).toUpperCase() + option.slice(1)}
            </Link>
          ))}
        </div>
        <form className="flex flex-wrap gap-2" action="/settings/staff">
          {activeStatus !== "active" ? <input type="hidden" name="status" value={activeStatus} /> : null}
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by name or email…"
            className="min-h-[44px] w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white sm:w-56"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load staff. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {staff.length > 0 ? (
              staff.map((person) => {
                const isYou = person.id === viewer?.id;
                const roleLabels = rolesByUser.get(person.id) ?? [];
                return (
                  <li key={person.id}>
                    <Link
                      href={`/settings/staff/${person.id}`}
                      className="flex flex-col gap-2 px-5 py-4 hover:bg-neutral-50 sm:flex-row sm:items-center sm:justify-between dark:hover:bg-neutral-800/50"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{`${person.first_name} ${person.last_name}`.trim()}</span>
                          {isYou ? (
                            <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                              You
                            </span>
                          ) : null}
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[person.status]}`}>
                            {person.status.charAt(0).toUpperCase() + person.status.slice(1)}
                          </span>
                        </div>
                        <p className="mt-0.5 min-w-0 break-words text-sm text-neutral-500">
                          {person.email ?? "No email on record"}
                          {roleLabels.length > 0 ? ` · ${roleLabels.join(", ")}` : " · No role assigned"}
                        </p>
                      </div>
                      <div className="flex-shrink-0 text-sm text-neutral-500 sm:text-right">
                        {person.last_login_at
                          ? `Last active ${new Date(person.last_login_at).toLocaleDateString("en-GB", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })}`
                          : "No logins yet"}
                      </div>
                    </Link>
                  </li>
                );
              })
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500">No staff match this filter.</li>
            )}
          </ul>
        </div>
      )}

      {totalCount > PAGE_SIZE ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-neutral-500">
            Page {pageNumber} of {lastPage} · {totalCount} staff
          </span>
          <div className="flex gap-2">
            {pageNumber > 1 ? (
              <Link href={{ pathname: "/settings/staff", query: pageQuery({ page: String(pageNumber - 1) }) }}>
                <Button variant="secondary">Previous</Button>
              </Link>
            ) : null}
            {pageNumber < lastPage ? (
              <Link href={{ pathname: "/settings/staff", query: pageQuery({ page: String(pageNumber + 1) }) }}>
                <Button variant="secondary">Next</Button>
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}