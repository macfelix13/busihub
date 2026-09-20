import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ACTION_LABELS, actionLabel, describeAuditEntry } from "@/lib/audit/labels";

export const metadata = { title: "Activity log — Busihub Admin" };

const PAGE_SIZE = 50;

interface AuditLogRow {
  id: string;
  business_id: string | null;
  branch_id: string | null;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface BusinessNameRow {
  id: string;
  name: string;
}

interface NameRow {
  id: string;
  first_name: string;
  last_name: string;
}

/**
 * The platform-wide counterpart to app/(app)/settings/audit-log/page.tsx
 * (one business's own trail) — until now nothing in /admin showed this at
 * all, even though every sensitive Super Admin action (granting Super
 * Admin, suspending a business, changing a plan's price, moving a
 * business onto a different subscription) was already being written to
 * audit_logs, and audit_logs_select (0009) already lets app_is_super_admin()
 * read every row regardless of business_id — including the null-business_id
 * rows a plan-catalog change writes (0059), which no business's own
 * scoped audit log could ever show. This page is the first place any of
 * that was actually visible without a raw SQL query against production.
 *
 * Deliberately NOT scoped to any single business_id, same reasoning as
 * app/admin/businesses/page.tsx and app/admin/support/page.tsx: RLS only
 * returns every row here because the caller already passed the
 * isSuperAdmin() check in app/admin/layout.tsx.
 */
export default async function AdminAuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; page?: string }>;
}) {
  const { action, page } = await searchParams;
  const pageNumber = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);

  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("audit_logs")
    .select("id, business_id, branch_id, actor_user_id, action, resource_type, resource_id, metadata, created_at", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .range((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE - 1);

  if (action && action !== "all") {
    query = query.eq("action", action);
  }

  const { data: rows, error, count } = await query;
  if (error) {
    console.error("AdminAuditLogPage: query failed", error);
  }

  const entries = (rows ?? []) as AuditLogRow[];
  const businessIds = [...new Set(entries.map((e) => e.business_id).filter((id): id is string => Boolean(id)))];

  // Same "platform.* never resolves to a visible profile" convention as
  // the tenant audit-log page — here it's not an RLS visibility gap (a
  // Super Admin can see every profile, 0009), it's just that a
  // platform.* action's actor really is Busihub itself, not a colleague.
  const profileIds = new Set<string>();
  for (const row of entries) {
    if (row.actor_user_id && !row.action.startsWith("platform.")) profileIds.add(row.actor_user_id);
    if (row.resource_type === "profile" && row.resource_id) profileIds.add(row.resource_id);
  }

  const [{ data: businessRows, error: businessError }, { data: nameRows, error: nameError }] = await Promise.all([
    businessIds.length > 0
      ? supabase.from("businesses").select("id, name").in("id", businessIds)
      : Promise.resolve({ data: [] as BusinessNameRow[], error: null }),
    profileIds.size > 0
      ? supabase.from("profiles").select("id, first_name, last_name").in("id", Array.from(profileIds))
      : Promise.resolve({ data: [] as NameRow[], error: null }),
  ]);

  if (businessError) console.error("AdminAuditLogPage: businesses lookup failed", businessError);
  if (nameError) console.error("AdminAuditLogPage: names query failed", nameError);

  const businessNameById = new Map(((businessRows ?? []) as BusinessNameRow[]).map((b) => [b.id, b.name]));
  const nameById = new Map<string, string>();
  for (const row of (nameRows ?? []) as NameRow[]) {
    nameById.set(row.id, `${row.first_name} ${row.last_name}`.trim());
  }

  const totalCount = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageQuery = (overrides: Record<string, string>) => ({
    ...(action && action !== "all" ? { action } : {}),
    ...overrides,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Activity log</h1>
        <p className="text-neutral-500 dark:text-ink-muted">
          Every sensitive action recorded platform-wide, across every business, {totalCount} total.
        </p>
      </div>

      <SegmentedControl
        options={(["all", ...Object.keys(ACTION_LABELS)] as const).map((option) => ({
          key: option,
          label: option === "all" ? "All" : actionLabel(option),
          active: (action ?? "all") === option,
          href: { pathname: "/admin/audit-log", query: { action: option } },
          className: "whitespace-nowrap",
        }))}
      />

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load the activity log. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-surface-line dark:bg-surface-card">
          <ul className="divide-y divide-neutral-100 dark:divide-surface-line">
            {entries.length > 0 ? (
              entries.map((entry) => {
                const actorName = entry.action.startsWith("platform.")
                  ? "Busihub"
                  : entry.actor_user_id
                    ? (nameById.get(entry.actor_user_id) ?? "A former colleague")
                    : "System";
                const targetName = entry.resource_type === "profile" && entry.resource_id ? (nameById.get(entry.resource_id) ?? null) : null;
                const businessName = entry.business_id ? (businessNameById.get(entry.business_id) ?? "Unknown business") : null;

                return (
                  <li key={entry.id} className="flex flex-col gap-1 px-5 py-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-surface dark:text-ink-muted">
                          {actionLabel(entry.action)}
                        </span>
                        {entry.business_id ? (
                          <Link
                            href={`/admin/businesses/${entry.business_id}`}
                            className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300"
                          >
                            {businessName}
                          </Link>
                        ) : (
                          <span className="text-xs text-neutral-400 dark:text-ink-muted/70">Platform-wide</span>
                        )}
                      </div>
                      <span className="flex-shrink-0 text-xs text-neutral-500 dark:text-ink-muted">
                        {new Date(entry.created_at).toLocaleString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <p className="min-w-0 break-words text-sm text-neutral-700 dark:text-ink">
                      {describeAuditEntry(entry, actorName, targetName)}
                    </p>
                  </li>
                );
              })
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500 dark:text-ink-muted">Nothing recorded yet for this filter.</li>
            )}
          </ul>
        </div>
      )}

      {totalCount > PAGE_SIZE ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-neutral-500 dark:text-ink-muted">
            Page {pageNumber} of {lastPage} · {totalCount} entries
          </span>
          <div className="flex gap-2">
            {pageNumber > 1 ? (
              <Link href={{ pathname: "/admin/audit-log", query: pageQuery({ page: String(pageNumber - 1) }) }}>
                <Button variant="secondary">Previous</Button>
              </Link>
            ) : null}
            {pageNumber < lastPage ? (
              <Link href={{ pathname: "/admin/audit-log", query: pageQuery({ page: String(pageNumber + 1) }) }}>
                <Button variant="secondary">Next</Button>
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}