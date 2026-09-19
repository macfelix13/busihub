import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusToggleButton } from "@/app/(app)/products/status-toggle-button";
import { resolveSupportRequest } from "./actions";

export const metadata = { title: "Support requests — Busihub Admin" };

const PAGE_SIZE = 50;

type RequestStatus = "open" | "resolved";

interface SupportRequestRow {
  id: string;
  business_id: string;
  submitted_by: string | null;
  message: string;
  status: RequestStatus;
  created_at: string;
  resolved_at: string | null;
}

interface BusinessNameRow {
  id: string;
  name: string;
}

interface SenderRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
}

export default async function AdminSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const { status, page } = await searchParams;
  const activeStatus: RequestStatus | "all" = status === "resolved" || status === "all" ? status : "open";
  const pageNumber = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);

  const supabase = await createServerSupabaseClient();

  // Deliberately not scoped to any single business_id — same reasoning as
  // app/admin/businesses/page.tsx: RLS (support_requests_select, 0057)
  // only returns every row here because the caller passed the
  // isSuperAdmin() check in app/admin/layout.tsx.
  let query = supabase
    .from("support_requests")
    .select("id, business_id, submitted_by, message, status, created_at, resolved_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE - 1);

  if (activeStatus !== "all") {
    query = query.eq("status", activeStatus);
  }

  const { data: requestRows, error, count } = await query;

  if (error) {
    console.error("AdminSupportPage: support_requests query failed", error);
  }

  const requests = (requestRows ?? []) as SupportRequestRow[];
  const businessIds = [...new Set(requests.map((r) => r.business_id))];
  const senderIds = requests.map((r) => r.submitted_by).filter((id): id is string => Boolean(id));

  const [{ data: businessRows, error: businessError }, { data: senderRows, error: senderError }] = await Promise.all([
    businessIds.length > 0
      ? supabase.from("businesses").select("id, name").in("id", businessIds)
      : Promise.resolve({ data: [] as BusinessNameRow[], error: null }),
    senderIds.length > 0
      ? supabase.from("profiles").select("id, first_name, last_name, email").in("id", senderIds)
      : Promise.resolve({ data: [] as SenderRow[], error: null }),
  ]);

  if (businessError) console.error("AdminSupportPage: businesses lookup failed", businessError);
  if (senderError) console.error("AdminSupportPage: senders lookup failed", senderError);

  const businessNameById = new Map(
    ((businessRows ?? []) as BusinessNameRow[]).map((b) => [b.id, b.name])
  );
  const senderById = new Map(((senderRows ?? []) as SenderRow[]).map((s) => [s.id, s as SenderRow]));

  const totalCount = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageQuery = (overrides: Record<string, string>) => ({
    ...(activeStatus !== "open" ? { status: activeStatus } : {}),
    ...overrides,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Support requests</h1>
        <p className="text-neutral-500 dark:text-ink-muted">
          Messages sent from a business&apos;s dashboard, {totalCount} total.
        </p>
      </div>

      <SegmentedControl
        options={(["open", "resolved", "all"] as const).map((option) => ({
          key: option,
          label: option === "all" ? "All" : option.charAt(0).toUpperCase() + option.slice(1),
          active: activeStatus === option,
          href: { pathname: "/admin/support", query: { status: option } },
        }))}
      />

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load support requests. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-surface-line dark:bg-surface-card">
          <ul className="divide-y divide-neutral-100 dark:divide-surface-line">
            {requests.length > 0 ? (
              requests.map((request) => {
                const sender = request.submitted_by ? senderById.get(request.submitted_by) : null;
                const senderName = sender ? `${sender.first_name} ${sender.last_name}`.trim() : "Unknown sender";
                return (
                  <li key={request.id} className="flex flex-col gap-2 px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          href={`/admin/businesses/${request.business_id}`}
                          className="font-medium text-brand-700 hover:underline dark:text-brand-300"
                        >
                          {businessNameById.get(request.business_id) ?? "Unknown business"}
                        </Link>
                        <p className="mt-0.5 text-xs text-neutral-500 dark:text-ink-muted">
                          {senderName}
                          {sender?.email ? ` · ${sender.email}` : ""} ·{" "}
                          {new Date(request.created_at).toLocaleString("en-GB", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                      {request.status === "open" ? (
                        <StatusToggleButton
                          action={resolveSupportRequest.bind(null, request.id)}
                          label="Mark resolved"
                          pendingLabel="Resolving…"
                          variant="secondary"
                        />
                      ) : (
                        <span className="flex-shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
                          Resolved
                          {request.resolved_at
                            ? ` ${new Date(request.resolved_at).toLocaleDateString("en-GB", {
                                day: "numeric",
                                month: "short",
                              })}`
                            : ""}
                        </span>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-neutral-800 dark:text-ink">{request.message}</p>
                  </li>
                );
              })
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500 dark:text-ink-muted">
                No {activeStatus !== "all" ? activeStatus : ""} support requests.
              </li>
            )}
          </ul>
        </div>
      )}

      {totalCount > PAGE_SIZE ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-neutral-500 dark:text-ink-muted">
            Page {pageNumber} of {lastPage} · {totalCount} requests
          </span>
          <div className="flex gap-2">
            {pageNumber > 1 ? (
              <Link href={{ pathname: "/admin/support", query: pageQuery({ page: String(pageNumber - 1) }) }}>
                <Button variant="secondary">Previous</Button>
              </Link>
            ) : null}
            {pageNumber < lastPage ? (
              <Link href={{ pathname: "/admin/support", query: pageQuery({ page: String(pageNumber + 1) }) }}>
                <Button variant="secondary">Next</Button>
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}