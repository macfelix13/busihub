/**
 * Human labels and one-line descriptions for every action this app writes
 * to audit_logs, via log_audit_event() (0008). Shared by
 * app/(app)/settings/audit-log/page.tsx (one business's own trail) and
 * app/admin/audit-log/page.tsx (Super Admin's platform-wide trail) so
 * there is exactly one place to update when a new log_audit_event() call
 * site is added — before this file existed, the tenant page kept its own
 * private copy of this map, and it drifted out of date the moment Phase
 * 18 (migration 0058) and its follow-up (0059) added six new
 * `platform.subscription_*`/`platform.subscription_plan_*` actions
 * without anyone updating it: those actions were real and already being
 * logged, they just fell through to `describe()`'s generic fallback line
 * instead of a real sentence. This file is the fix, and the shared import
 * is what stops it from silently happening again.
 *
 * Pure — no I/O, no Supabase client. Resolving an actor's or target's
 * *name* (a `profiles` lookup) stays in each page, since that's genuinely
 * different per page (a business's own audit log only ever needs to
 * resolve its own staff; the platform-wide one needs to resolve staff
 * across every business). What's shared is just "what does this action
 * mean", which is the same everywhere.
 */

export interface AuditEntryLike {
  action: string;
  actor_user_id: string | null;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
}

export const ACTION_LABELS: Record<string, string> = {
  "business.registered": "Business registered",
  "user.pin_set": "PIN set",
  "user.invited": "Staff invited",
  "user.role_changed": "Role changed",
  "user.deactivated": "Staff deactivated",
  "user.reactivated": "Staff reactivated",
  "role.permissions_updated": "Role permissions updated",
  "platform.super_admin_granted": "Super Admin granted",
  "platform.business_suspended": "Account suspended by Busihub",
  "platform.business_reactivated": "Account reactivated by Busihub",
  "platform.subscription_updated": "Subscription updated",
  "platform.subscription_trial_ended": "Trial ended",
  "platform.subscription_expired": "Subscription expired",
  "platform.subscription_cancelled": "Subscription cancelled",
  "platform.subscription_plan_created": "Plan created",
  "platform.subscription_plan_updated": "Plan updated",
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

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/**
 * One-line, past-tense description of an audit entry. `actorName` and
 * `targetName` are resolved by the caller (a profiles lookup, or
 * "Busihub" for a platform.* action — see each page's own convention)
 * since that needs a database round trip this module deliberately stays
 * free of.
 */
export function describeAuditEntry(entry: AuditEntryLike, actorName: string, targetName: string | null): string {
  const metadata = entry.metadata ?? {};
  switch (entry.action) {
    case "business.registered":
      return `${actorName} registered this business.`;
    case "user.pin_set":
      // Compared by id, not by display name — two different colleagues
      // can share a name, and this is the original tenant audit-log
      // page's own comparison (row.actor_user_id === row.resource_id),
      // preserved exactly rather than approximated by name.
      return entry.actor_user_id === entry.resource_id
        ? `${actorName} set their own PIN.`
        : `${actorName} set a PIN for ${targetName ?? "a colleague"}.`;
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
    case "role.permissions_updated": {
      const count = typeof metadata.permission_count === "number" ? metadata.permission_count : null;
      return `${actorName} updated a role's permissions${count !== null ? ` (${count} permission${count === 1 ? "" : "s"})` : ""}.`;
    }
    case "platform.super_admin_granted":
      return `${actorName} was granted Super Admin.`;
    case "platform.business_suspended":
      return "Busihub suspended this business's account.";
    case "platform.business_reactivated":
      return "Busihub reactivated this business's account.";
    case "platform.subscription_updated": {
      const plan = typeof metadata.plan_slug === "string" ? metadata.plan_slug : "a different";
      const status = typeof metadata.to_status === "string" ? metadata.to_status : null;
      return `${actorName} moved this business onto the ${plan} plan${status ? ` (status: ${status})` : ""}.`;
    }
    case "platform.subscription_trial_ended":
      return `${actorName} moved this business into a grace period — its trial ended with no plan chosen.`;
    case "platform.subscription_expired":
      return `${actorName} locked this business out — its grace period ended with no plan chosen.`;
    case "platform.subscription_cancelled":
      return `${actorName} cancelled this business's subscription, as scheduled.`;
    case "platform.subscription_plan_created":
      return `${actorName} created the "${typeof metadata.name === "string" ? metadata.name : "a"}" plan.`;
    case "platform.subscription_plan_updated":
      return `${actorName} updated the "${typeof metadata.name === "string" ? metadata.name : "a"}" plan.`;
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
      return `${actorName} — ${entry.resource_type}${entry.resource_id ? ` (${entry.resource_id.slice(0, 8)}…)` : ""}.`;
  }
}