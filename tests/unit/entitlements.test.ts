import { describe, expect, it } from "vitest";
import {
  PAST_DUE_GRACE_DAYS,
  daysUntil,
  graceDaysRemaining,
  isGracePeriodStatus,
  isLockedOutStatus,
  resolveLimitCheck,
  type SubscriptionStatus,
} from "@/lib/entitlements/limits";

describe("resolveLimitCheck", () => {
  it("allows a count below the limit, with the correct remaining", () => {
    expect(resolveLimitCheck(5, 3)).toEqual({ allowed: true, limit: 5, remaining: 2 });
  });

  it("blocks a count already at the limit — the same >= rule as 0058's app_enforce_limit()", () => {
    expect(resolveLimitCheck(5, 5)).toEqual({ allowed: false, limit: 5, remaining: 0 });
  });

  it("blocks a count already past the limit (a plan downgrade could leave a business over its new limit)", () => {
    expect(resolveLimitCheck(5, 9)).toEqual({ allowed: false, limit: 5, remaining: 0 });
  });

  it("treats a null limit as unlimited regardless of count", () => {
    expect(resolveLimitCheck(null, 1_000_000)).toEqual({ allowed: true, limit: null, remaining: null });
  });

  it("allows zero used against a limit of zero-or-more correctly (edge: limit of 0 blocks immediately)", () => {
    expect(resolveLimitCheck(0, 0)).toEqual({ allowed: false, limit: 0, remaining: 0 });
  });
});

describe("isLockedOutStatus / isGracePeriodStatus", () => {
  const all: SubscriptionStatus[] = ["trialing", "active", "past_due", "suspended", "cancelled", "expired"];

  it("locks out exactly suspended/cancelled/expired, nothing else", () => {
    const locked = all.filter(isLockedOutStatus);
    expect(locked.sort()).toEqual(["cancelled", "expired", "suspended"]);
  });

  it("treats past_due as the grace-period banner state, never as a lockout", () => {
    expect(isLockedOutStatus("past_due")).toBe(false);
    expect(isGracePeriodStatus("past_due")).toBe(true);
  });

  it("trialing and active are neither locked out nor in the grace period", () => {
    for (const status of ["trialing", "active"] as SubscriptionStatus[]) {
      expect(isLockedOutStatus(status)).toBe(false);
      expect(isGracePeriodStatus(status)).toBe(false);
    }
  });
});

describe("graceDaysRemaining", () => {
  const now = new Date("2026-09-19T12:00:00Z");

  it("counts down from the full grace period the moment past_due starts", () => {
    expect(graceDaysRemaining(now.toISOString(), now)).toBe(PAST_DUE_GRACE_DAYS);
  });

  it("returns fewer days as time passes", () => {
    const oneDayIn = new Date("2026-09-18T12:00:00Z"); // past_due_since
    expect(graceDaysRemaining(oneDayIn.toISOString(), now)).toBe(PAST_DUE_GRACE_DAYS - 1);
  });

  it("never goes negative once the grace period has elapsed — 0, not a negative count", () => {
    const wayBack = new Date("2026-09-01T12:00:00Z");
    expect(graceDaysRemaining(wayBack.toISOString(), now)).toBe(0);
  });

  it("returns null when there is no past_due_since to count from", () => {
    expect(graceDaysRemaining(null, now)).toBeNull();
  });
});

describe("daysUntil", () => {
  const now = new Date("2026-09-19T12:00:00Z");

  it("counts whole days forward to a future date", () => {
    expect(daysUntil("2026-09-29T12:00:00Z", now)).toBe(10);
  });

  it("is negative once the target date has passed", () => {
    expect(daysUntil("2026-09-09T12:00:00Z", now)).toBe(-10);
  });

  it("returns null for a null target (e.g. an Enterprise plan with no fixed period end)", () => {
    expect(daysUntil(null, now)).toBeNull();
  });
});