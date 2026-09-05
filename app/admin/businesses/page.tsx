import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Businesses — Busihub Admin" };

const PAGE_SIZE = 50;

type BusinessStatus = "active" | "suspended" | "closed";

interface BusinessRow {
  id: string;
  name: string;
  status: BusinessStatus;
  business_type: string | null;
  created_at: string;
  created_by: string | null;
}

interface OwnerRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
}

const STATUS_BADGE: Record<BusinessStatus, string> = {
  active: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  suspended: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  closed: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
};

export default async function AdminBusinessesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const { q, status, page } = await searchParams;
  const activeStatus: BusinessStatus | "all" =
    status === "suspended" || status === "closed" || status === "all" ? status : "active";
  const pageNumber = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);

  const supabase = await createServerSupabaseClient();

  // Deliberately NOT scoped to any single business_id — this is the one
  // place in the whole app where that's correct rather than a bug. RLS
  // (businesses_select, 0009) only returns every row here because the
  // caller passed the isSuperAdmin() check in app/admin/layout.tsx; for
  // anyone else this same query would return just their own business.
  let query = supabase
    .from("businesses")
    .select("id, name, status, business_type, created_at, created_by", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE - 1);

  if (activeStatus !== "all") {
    query = query.eq("status", activeStatus);
  }
  if (q && q.trim().length > 0) {
    query = query.ilike("name", `%${q.trim()}%`);
  }

  const { data: businessRows, error, count } = await query;

  if (error) {
    console.error("AdminBusinessesPage: businesses query failed", error);
  }

  const businesses = (businessRows ?? []) as BusinessRow[];
  const businessIds = businesses.map((b) => b.id);
  const ownerIds = businesses.map((b) => b.created_by).filter((id): id is string => Boolean(id));

  const [{ data: ownerRows, error: ownersError }, { data: staffRows, error: staffError }] = await Promise.all([
    ownerIds.length > 0
      ? supabase.from("profiles").select("id, first_name, last_name, email, phone").in("id", ownerIds)
      : Promise.resolve({ data: [] as OwnerRow[], error: null }),
    businessIds.length > 0
      ? supabase.from("profiles").select("business_id, last_login_at").in("business_id", businessIds)
      : Promise.resolve({ data: [] as { business_id: string | null; last_login_at: string | null }[], error: null }),
  ]);

  if (ownersError) console.error("AdminBusinessesPage: owners query failed", ownersError);
  if (staffError) console.error("AdminBusinessesPage: staff query failed", staffError);

  const ownerById = new Map<string, OwnerRow>((ownerRows ?? []).map((o) => [o.id, o as OwnerRow]));

  const staffStatsByBusiness = new Map<string, { count: number; lastLoginAt: string | null }>();
  for (const row of staffRows ?? []) {
    const r = row as { business_id: string | null; last_login_at: string | null };
    if (!r.business_id) continue;
    const existing = staffStatsByBusiness.get(r.business_id) ?? { count: 0, lastLoginAt: null };
    existing.count += 1;
    if (r.last_login_at && (!existing.lastLoginAt || r.last_login_at > existing.lastLoginAt)) {
      existing.lastLoginAt = r.last_login_at;
    }
    staffStatsByBusiness.set(r.business_id, existing);
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
      <div>
        <h1 className="text-2xl font-semibold">Businesses</h1>
        <p className="text-neutral-500">Every business registered on Busihub, {totalCount} total.</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1 rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
          {(["active", "suspended", "closed", "all"] as const).map((option) => (
            <Link
              key={option}
              href={{ pathname: "/admin/businesses", query: { ...(q ? { q } : {}), status: option } }}
              className={tabClass(activeStatus === option)}
            >
              {option === "all" ? "All" : option.charAt(0).toUpperCase() + option.slice(1)}
            </Link>
          ))}
        </div>
        <form className="flex flex-wrap gap-2" action="/admin/businesses">
          {activeStatus !== "active" ? <input type="hidden" name="status" value={activeStatus} /> : null}
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by name…"
            className="min-h-[44px] w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white sm:w-56"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load businesses. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {businesses.length > 0 ? (
              businesses.map((business) => {
                const owner = business.created_by ? ownerById.get(business.created_by) : null;
                const stats = staffStatsByBusiness.get(business.id);
                return (
                  <li key={business.id}>
                    <Link
                      href={`/admin/businesses/${business.id}`}
                      className="flex flex-col gap-2 px-5 py-4 hover:bg-neutral-50 sm:flex-row sm:items-center sm:justify-between dark:hover:bg-neutral-800/50"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{business.name}</span>
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[business.status]}`}>
                            {business.status.charAt(0).toUpperCase() + business.status.slice(1)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-sm text-neutral-500">
                          {owner ? `${owner.first_name} ${owner.last_name}`.trim() : "No registering owner on record"}
                          {owner?.email ? ` · ${owner.email}` : ""}
                          {owner?.phone ? ` · ${owner.phone}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-shrink-0 flex-col text-sm text-neutral-500 sm:text-right">
                        <span>
                          {stats?.count ?? 0} {stats?.count === 1 ? "staff" : "staff"}
                        </span>
                        <span>
                          {stats?.lastLoginAt
                            ? `Last active ${new Date(stats.lastLoginAt).toLocaleDateString("en-GB", {
                                day: "numeric",
                                month: "short",
                                year: "numeric",
                              })}`
                            : "No logins yet"}
                        </span>
                        <span>
                          Signed up{" "}
                          {new Date(business.created_at).toLocaleDateString("en-GB", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500">No businesses match this filter.</li>
            )}
          </ul>
        </div>
      )}

      {totalCount > PAGE_SIZE ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-neutral-500">
            Page {pageNumber} of {lastPage} · {totalCount} businesses
          </span>
          <div className="flex gap-2">
            {pageNumber > 1 ? (
              <Link href={{ pathname: "/admin/businesses", query: pageQuery({ page: String(pageNumber - 1) }) }}>
                <Button variant="secondary">Previous</Button>
              </Link>
            ) : null}
            {pageNumber < lastPage ? (
              <Link href={{ pathname: "/admin/businesses", query: pageQuery({ page: String(pageNumber + 1) }) }}>
                <Button variant="secondary">Next</Button>
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}