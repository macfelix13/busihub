import { describe, expect, it } from "vitest";
import { bucketLabel, resolvePeriod, RANGES } from "@/app/(app)/dashboard/period";

/**
 * The dashboard's date ranges.
 *
 * The case worth writing this file for is the timezone one. Ghana sits at
 * UTC+0, and the server keeps UTC, so a dashboard that computes "today"
 * in server time is indistinguishable from a correct one for every
 * business Busihub has. It breaks for the first shop outside that offset,
 * on the figure people check most — so it is tested against a zone that
 * is a long way from UTC, where the bug is visible.
 *
 * `range` also arrives straight from the address bar, so the other half
 * of this file is about what happens when it is junk.
 */

const ACCRA = "Africa/Accra";

describe("resolvePeriod", () => {
  it("defaults to today, bucketed by hour", () => {
    const now = new Date("2026-08-31T09:15:00Z");
    const period = resolvePeriod({}, ACCRA, now);

    expect(period.range).toBe("today");
    expect(period.bucket).toBe("hour");
    expect(period.from.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    // Exclusive end: the whole of today is inside the range.
    expect(period.to.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("computes the day boundary in the shop's timezone, not the server's", () => {
    // 23:30 UTC on the 31st is already 11:30 on the 1st in Auckland. A
    // shopkeeper there opening the dashboard must see the 1st's takings,
    // starting from midnight THEIR time — 12:00 UTC on the 31st.
    const now = new Date("2026-08-31T23:30:00Z");
    const period = resolvePeriod({}, "Pacific/Auckland", now);

    expect(period.from.toISOString()).toBe("2026-08-31T12:00:00.000Z");
    expect(period.to.toISOString()).toBe("2026-09-01T12:00:00.000Z");
  });

  it("handles a zone behind UTC too", () => {
    // 01:00 UTC on the 31st is still 21:00 on the 30th in New York.
    const now = new Date("2026-08-31T01:00:00Z");
    const period = resolvePeriod({}, "America/New_York", now);

    expect(period.from.toISOString()).toBe("2026-08-30T04:00:00.000Z");
  });

  it("falls back to Accra when the timezone is missing or nonsense", () => {
    const now = new Date("2026-08-31T09:15:00Z");

    expect(resolvePeriod({}, null, now).timezone).toBe(ACCRA);
    expect(resolvePeriod({}, "Middle/Earth", now).timezone).toBe(ACCRA);
    // And still produces a usable period rather than throwing.
    expect(resolvePeriod({}, "Middle/Earth", now).from.toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });

  it("treats an unrecognised range as today", () => {
    const now = new Date("2026-08-31T09:15:00Z");

    for (const junk of ["", "all", "../../etc", "DROP TABLE sales", "decade"]) {
      const period = resolvePeriod({ range: junk }, ACCRA, now);
      expect(period.range).toBe("today");
    }
  });

  it("offers every advertised range and buckets each sensibly", () => {
    const now = new Date("2026-08-31T09:15:00Z");
    const buckets = RANGES.map((r) => resolvePeriod({ range: r.value }, ACCRA, now).bucket);

    expect(buckets).toEqual(["hour", "day", "day", "week", "month"]);
  });

  it("covers seven whole days for the week range, today included", () => {
    const now = new Date("2026-08-31T09:15:00Z");
    const period = resolvePeriod({ range: "week" }, ACCRA, now);

    expect(period.from.toISOString()).toBe("2026-08-25T00:00:00.000Z");
    expect(period.to.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect((period.to.getTime() - period.from.getTime()) / 86_400_000).toBe(7);
  });

  it("starts the month range on the first, not thirty days ago", () => {
    const now = new Date("2026-08-31T09:15:00Z");
    const period = resolvePeriod({ range: "month" }, ACCRA, now);

    expect(period.from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("accepts a custom range and includes the whole of the last day", () => {
    const now = new Date("2026-08-31T09:15:00Z");
    const period = resolvePeriod({ from: "2026-08-01", to: "2026-08-07" }, ACCRA, now);

    expect(period.range).toBe("custom");
    expect(period.from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    // The 7th's sales are in the period, so the end is the 8th's midnight.
    expect(period.to.toISOString()).toBe("2026-08-08T00:00:00.000Z");
    expect(period.bucket).toBe("day");
  });

  it("widens the bucket rather than drawing four hundred bars", () => {
    const now = new Date("2026-12-31T09:15:00Z");

    expect(resolvePeriod({ from: "2026-01-01", to: "2026-12-31" }, ACCRA, now).bucket).toBe("week");
    expect(resolvePeriod({ from: "2020-01-01", to: "2026-12-31" }, ACCRA, now).bucket).toBe("month");
  });

  it("ignores a custom range that is malformed or the wrong way round", () => {
    const now = new Date("2026-08-31T09:15:00Z");

    // Backwards.
    expect(resolvePeriod({ from: "2026-08-07", to: "2026-08-01" }, ACCRA, now).range).toBe("today");
    // Not a date.
    expect(resolvePeriod({ from: "yesterday", to: "today" }, ACCRA, now).range).toBe("today");
    // Half a range.
    expect(resolvePeriod({ from: "2026-08-01" }, ACCRA, now).range).toBe("today");
    // Real shape, impossible date — must not produce an Invalid Date.
    const nonsense = resolvePeriod({ from: "2026-02-31", to: "2026-13-45" }, ACCRA, now);
    expect(Number.isNaN(nonsense.from.getTime())).toBe(false);
  });

  it("keeps an explicit range when a broken custom range is also present", () => {
    const now = new Date("2026-08-31T09:15:00Z");
    const period = resolvePeriod({ range: "week", from: "nope", to: "also nope" }, ACCRA, now);

    expect(period.range).toBe("week");
  });
});

describe("bucketLabel", () => {
  it("labels each bucket at the resolution it covers", () => {
    const iso = "2026-08-31T14:00:00.000Z";

    expect(bucketLabel(iso, "hour", ACCRA)).toBe("14:00");
    expect(bucketLabel(iso, "day", ACCRA)).toBe("31 Aug");
    expect(bucketLabel(iso, "month", ACCRA)).toBe("Aug");
  });

  it("labels in the shop's timezone", () => {
    // Midnight UTC is 3am in Nairobi, still the same day.
    expect(bucketLabel("2026-08-31T00:00:00.000Z", "hour", "Africa/Nairobi")).toBe("03:00");
    // ...but 8pm the previous evening in New York.
    expect(bucketLabel("2026-08-31T00:00:00.000Z", "day", "America/New_York")).toBe("30 Aug");
  });
});