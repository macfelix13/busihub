import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";

export const metadata = { title: "Audit log" };

const PAGE_SIZE = 50;

interface AuditLogRow {
  id: string;
  branch_id: string | null;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface NameRow {
  id: string;
  first_name: string;
  last_name: string;
}

/** Human labels for every action this app currently writes to audit_logs
 *  (grep-confirmed against supabase/migrations/*.sql and app/**\/actions.ts —
 *  update this alongside any new log_audit_event() call site). */
const ACTION_LABELS: Record<string, string> = {
  "business.registered": "Business registered",
  "user.pin_set": "PIN set",
  "user.invited": "Staff invited",
  "user.role_changed": "Role changed",
  "user.deactivated": "Staff deactivated",
  "user.reactivated": "Staff reactivated",
  "platform.super_admin_granted": "Super Admin granted",
  "platform.business_suspended": "Account suspended by Busihub",
  "platform.business_reactivated": "Account reactivated by Busihub",
  "payment_settings.connected": "Payment account connected",
  "payment_settings.updated": "Payment settings updated",
  "payment_settings.disconnected": "Payment account disconnected",
  "payment_settings.webhook_regenerated": "Payment webhook regenerated",
  "till.no_sale": "Till opened with no sale",
  "paystack_webhook.invalid_signature": "Rejected webhook (bad signature)",
  "paystack_webhook.duplicate_ignored": "Duplicate webhook ignored",
  // Added in the 2026-09 security review (Gaps #2 and #5) — refunds,
  // voids, and the other sensitive mutations that previously left no
  // audit trail at all. See supabase/migrations/0049_audit_log_gaps.sql
  // and docs/SECURITY_AUDIT_2026-09.md.
  "sale.voided": "Sale voided",
  "sale.refunded": "Sale refunded",
  "expense.voided": "Expense voided",
  "customer.credit_limit_changed": "Customer credit limit changed",
  "branch.created": "Branch created",
  "branch.updated": "Branch updated",
  "business.profile_updated": "Business profile updated",
  "business.settings_updated": "Business settings updated",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function describe(row: AuditLogRow, actorName: string, targetName: string | null): string {
  const metadata = row.metadata ?? {};
  switch (row.action) {
    case "business.registered":
      return `${actorName} registered this business.`;
    case "user.pin_set":
      return row.actor_user_id === row.resource_id ? `${actorName} set their own PIN.` : `${actorName} set a PIN for ${targetName ?? "a colleague"}.`;
    case "user.invited":
      return `${actorName} invited ${typeof metadata.email === "string" ? metadata.email : "a colleague"} as ${
        typeof metadata.role_name === "string" ? metadata.role_name : "a role"
      }.`;
    case "user.role_changed":
      return `${actorName} changed ${targetName ?? "a colleague"}'s role to ${
        typeof metadata.new_role_name === "string" ? metadata.new_role_name : "no access at that branch"
      }.`;
    case "user.deactivated":
      return `${actorName} deactivated ${targetName ?? "a colleague"}'s account.`;
    case "user.reactivated":
      return `${actorName} reactivated ${targetName ?? "a colleague"}'s account.`;
    case "platform.super_admin_granted":
      return `${actorName} was granted Super Admin.`;
    case "platform.business_suspended":
      return "Busihub suspended this business's account.";
    case "platform.business_reactivated":
      return "Busihub reactivated this business's account.";
    case "payment_settings.connected":
      return `${actorName} connected a payment account.`;
    case "payment_settings.updated":
      return `${actorName} updated the payment settings.`;
    case "payment_settings.disconnected":
      return `${actorName} disconnected the payment account.`;
    case "payment_settings.webhook_regenerated":
      return `${actorName} regenerated the payment webhook identifier.`;
    case "till.no_sale":
      return `${actorName} opened the till drawer with no sale.`;
    case "paystack_webhook.invalid_signature":
      return "An incoming payment webhook was rejected — its signature did not match.";
    case "paystack_webhook.duplicate_ignored":
      return "An incoming payment webhook was ignored as a duplicate.";
    case "sale.voided": {
      const receipt = typeof metadata.receipt_number === "string" ? metadata.receipt_number : "a sale";
      return `${actorName} voided ${receipt}.`;
    }
    case "sale.refunded": {
      const refundNumber = typeof metadata.refund_number === "string" ? metadata.refund_number : "a refund";
      return `${actorName} recorded ${refundNumber}.`;
    }
    case "expense.voided": {
      const ref = typeof metadata.reference_number === "string" ? metadata.reference_number : "an expense";
      return `${actorName} voided expense ${ref}.`;
    }
    case "customer.credit_limit_changed": {
      const oldLimit = typeof metadata.old_credit_limit === "number" ? metadata.old_credit_limit : null;
      const newLimit = typeof metadata.new_credit_limit === "number" ? metadata.new_credit_limit : null;
      return `${actorName} changed ${targetName ?? "a customer"}'s credit limit${
        oldLimit !== null && newLimit !== null ? ` from ${oldLimit} to ${newLimit}` : ""
      }.`;
    }
    case "branch.created":
      return `${actorName} created a branch${typeof metadata.name === "string" ? ` ("${metadata.name}")` : ""}.`;
    case "branch.updated":
      return `${actorName} edited a branch${typeof metadata.name === "string" ? ` ("${metadata.name}")` : ""}.`;
    case "business.profile_updated":
      return `${actorName} updated the business profile.`;
    case "business.settings_updated":
      return `${actorName} updated the business settings.`;
    default:
      return `${actorName} — ${row.resource_type}${row.resource_id ? ` (${row.resource_id.slice(0, 8)}…)` : ""}.`;
  }
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; page?: string }>;
}) {
  const { action, page } = await searchParams;
  const pageNumber = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canViewAudit = await hasPermission(supabase, businessId, PERMISSIONS.AUDIT_VIEW);

  if (!canViewAudit) {
    redirect("/dashboard");
  }

  let query = supabase
    .from("audit_logs")
    .select("id, branch_id, actor_user_id, action, resource_type, resource_id, metadata, created_at", { count: "exact" })
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .range((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE - 1);

  if (action && action !== "all") {
    query = query.eq("action", action);
  }

  const { data: rows, error, count } = await query;
  if (error) {
    console.error("AuditLogPage: query failed", error);
  }

  const entries = (rows ?? []) as AuditLogRow[];

  // Platform-level actions (Busihub's own Super Admin console, not a
  // colleague) never resolve to a visible profile for a tenant — RLS
  // correctly hides another business's/the platform's own staff profiles
  // (0009) — so those are labeled "Busihub" below rather than left blank.
  const profileIds = new Set<string>();
  for (const row of entries) {
    if (row.actor_user_id && !row.action.startsWith("platform.")) profileIds.add(row.actor_user_id);
    if (row.resource_type === "profile" && row.resource_id) profileIds.add(row.resource_id);
  }

  const { data: nameRows, error: nameError } =
    profileIds.size > 0
      ? await supabase.from("profiles").select("id, first_name, last_name").in("id", Array.from(profileIds))
      : { data: [] as NameRow[], error: null };

  if (nameError) {
    console.error("AuditLogPage: names query failed", nameError);
  }

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
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-neutral-500">A record of sensitive actions taken on your business, {totalCount} total.</p>
      </div>

      <SegmentedControl
        options={(["all", ...Object.keys(ACTION_LABELS)] as const).map((option) => ({
          key: option,
          label: option === "all" ? "All" : actionLabel(option),
          active: (action ?? "all") === option,
          href: { pathname: "/settings/audit-log", query: { action: option } },
          className: "whitespace-nowrap",
        }))}
      />

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load the audit log. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {entries.length > 0 ? (
              entries.map((entry) => {
                const actorName = entry.action.startsWith("platform.")
                  ? "Busihub"
                  : entry.actor_user_id
                    ? (nameById.get(entry.actor_user_id) ?? "A former colleague")
                    : "System";
                const targetName = entry.resource_type === "profile" && entry.resource_id ? (nameById.get(entry.resource_id) ?? null) : null;

                return (
                  <li key={entry.id} className="flex flex-col gap-1 px-5 py-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                        {actionLabel(entry.action)}
                      </span>
                      <span className="flex-shrink-0 text-xs text-neutral-500">
                        {new Date(entry.created_at).toLocaleString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <p className="min-w-0 break-words text-sm text-neutral-700 dark:text-neutral-200">
                      {describe(entry, actorName, targetName)}
                    </p>
                  </li>
                );
              })
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500">Nothing recorded yet for this filter.</li>
            )}
          </ul>
        </div>
      )}

      {totalCount > PAGE_SIZE ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-neutral-500">
            Page {pageNumber} of {lastPage} · {totalCount} entries
          </span>
          <div className="flex gap-2">
            {pageNumber > 1 ? (
              <Link href={{ pathname: "/settings/audit-log", query: pageQuery({ page: String(pageNumber - 1) }) }}>
                <Button variant="secondary">Previous</Button>
              </Link>
            ) : null}
            {pageNumber < lastPage ? (
              <Link href={{ pathname: "/settings/audit-log", query: pageQuery({ page: String(pageNumber + 1) }) }}>
                <Button variant="secondary">Next</Button>
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}