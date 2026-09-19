/**
 * Pure entitlement-resolution functions (Section 11: "Unit (Vitest):
 * ... entitlement checks — pure functions, no I/O"). Everything here
 * takes plain data in and returns plain data out — no Supabase client,
 * no `now()` implicitly reached for (every time-based function takes
 * `now` as an explicit, defaulted parameter so a test can pin it).
 *
 * The REAL, hard enforcement for the three countable limits
 * (max_users/max_branches/max_products) lives in
 * supabase/migrations/0058_entitlements_enforcement.sql, inside the same
 * write paths the app already uses (a BEFORE INSERT trigger on branches,
 * and inside create_product()/invite_staff_member()) — this module is
 * NOT that gate. It exists so the UI can show "3 of 5 branches used"
 * and a friendly pre-check before a request round-trips to the server at
 * all, exactly the "friendly UI-level pre-check AND a hard server-side
 * check" split docs/ARCHITECTURE.md's Section 9 describes. Trusting only
 * this module and skipping the database's own check would be exactly
 * the client-trust mistake Section 7 warns against.
 */

/** Mirrors the `subscription_status` Postgres enum (0006). */
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "suspended" | "cancelled" | "expired";

/** Mirrors subscription_plans.limits.features (0010's seed data). */
export interface PlanFeatureFlags {
  advanced_reports: boolean;
  api_access: boolean;
  sms_notifications: boolean;
}

/**
 * Mirrors subscription_plans.limits (0010's seed data) exactly — a null
 * value for any numeric field means "unlimited" (Enterprise's
 * convention), never zero. `max_pos_terminals` and `storage_mb` are
 * carried here for completeness but have no live counter anywhere in
 * this codebase to check them against yet — see 0058's own file header
 * for why, and getUsageCounts() in lib/entitlements/queries.ts for what
 * IS actually counted.
 */
export interface PlanLimits {
  max_users: number | null;
  max_branches: number | null;
  max_products: number | null;
  max_pos_terminals: number | null;
  storage_mb: number | null;
  features: PlanFeatureFlags;
}

export interface LimitCheck {
  /** True for `currentCount < limit`, and always true for an unlimited (null) limit. */
  allowed: boolean;
  /** The plan's limit, or null if unlimited. */
  limit: number | null;
  /** How many more can be created before hitting the limit, or null if unlimited. Never negative. */
  remaining: number | null;
}

/**
 * The read-only counterpart to 0058's app_enforce_limit() SQL function —
 * same "null means unlimited" rule, same ">= means blocked" comparison
 * (a count already AT the limit has zero remaining and is not allowed to
 * create one more), kept in sync by hand since one lives in SQL and the
 * other in TypeScript.
 */
export function resolveLimitCheck(limit: number | null, currentCount: number): LimitCheck {
  if (limit === null) {
    return { allowed: true, limit: null, remaining: null };
  }
  return {
    allowed: currentCount < limit,
    limit,
    remaining: Math.max(limit - currentCount, 0),
  };
}

/**
 * Whether this status means the account should be locked out of the app
 * entirely (app/(app)/layout.tsx renders a "subscription required"
 * screen, same shape as the existing suspended-business one). Mirrors
 * process_subscription_lifecycle()'s own transitions: `past_due` is
 * deliberately NOT locked out — it is the grace window after a trial
 * ends, shown as a banner, not a wall (see PAST_DUE_GRACE_DAYS below).
 */
export function isLockedOutStatus(status: SubscriptionStatus): boolean {
  return status === "suspended" || status === "cancelled" || status === "expired";
}

/** Whether this status should show the "your trial ended, N days left" banner, without blocking anything yet. */
export function isGracePeriodStatus(status: SubscriptionStatus): boolean {
  return status === "past_due";
}

/** Mirrors the `v_grace_days` constant inside process_subscription_lifecycle() (0058) — kept in sync by hand, same as resolveLimitCheck() above. */
export const PAST_DUE_GRACE_DAYS = 3;

/**
 * Whole days left in the past_due grace window before
 * process_subscription_lifecycle() will move this business to `expired`.
 * Never negative — a grace period that has already elapsed (the cron
 * just hasn't run yet) reads as 0 days left, not a negative number.
 * Returns null if there's no past_due_since to count from (not
 * currently in the grace period at all).
 */
export function graceDaysRemaining(pastDueSince: string | Date | null, now: Date = new Date()): number | null {
  if (!pastDueSince) return null;
  const since = typeof pastDueSince === "string" ? new Date(pastDueSince) : pastDueSince;
  const elapsedDays = (now.getTime() - since.getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.ceil(PAST_DUE_GRACE_DAYS - elapsedDays));
}

/**
 * Whole days from `now` until `target` (trial_ends_at, current_period_end,
 * ...) — negative once `target` is in the past. Returns null for a null
 * target (an Enterprise-style plan with no fixed period end, for
 * instance).
 */
export function daysUntil(target: string | Date | null, now: Date = new Date()): number | null {
  if (!target) return null;
  const t = typeof target === "string" ? new Date(target) : target;
  return Math.ceil((t.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}