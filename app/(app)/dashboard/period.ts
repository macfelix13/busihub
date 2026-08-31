/**
 * The dashboard's date ranges, worked out in the SHOP's timezone.
 *
 * This matters more than it looks. The server this runs on keeps UTC, and
 * a shopkeeper checking "today's takings" at 8pm in a UTC+3 zone would
 * otherwise be shown a day that ended five hours ago — or worse, one that
 * has not started. Ghana is UTC+0 today, so the bug would be invisible
 * here and would surface on the first business outside it. So the
 * boundaries are computed against the branch's own timezone from the
 * start, rather than left as a thing to fix later.
 *
 * The ranges themselves are a closed set. `range=` arrives from the URL,
 * so it is matched against this list and anything unrecognised falls back
 * to today — a query parameter cannot widen what is asked for, only pick
 * from what is offered.
 */

export const RANGES = [
  { value: "today", label: "Today" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "This month" },
  { value: "quarter", label: "Last 90 days" },
  { value: "year", label: "This year" },
] as const;

export type RangeValue = (typeof RANGES)[number]["value"];

export interface Period {
  /** What was asked for, after validation. */
  range: RangeValue | "custom";
  from: Date;
  /** Exclusive: the instant the period ends. */
  to: Date;
  /** The bucket sales_trend() should group by. */
  bucket: "hour" | "day" | "week" | "month";
  timezone: string;
  label: string;
}

/**
 * How far `tz` is from UTC at a given instant, in milliseconds.
 * Formatting the instant in the zone and reading it back as if it were
 * UTC gives the offset — the only way to do this without a tz database
 * of our own.
 */
function offsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    // Intl gives 24 for midnight under hour12:false in some ICU versions.
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  return asIfUtc - at.getTime();
}

/** The instant at which the given wall-clock time occurs in `tz`. */
function fromZoned(tz: string, y: number, m: number, d: number, h = 0): Date {
  const naive = Date.UTC(y, m - 1, d, h);
  // Two passes: the first guess uses the offset at the naive instant,
  // which is wrong only across a DST boundary; the second corrects it.
  const first = new Date(naive - offsetMs(tz, new Date(naive)));
  return new Date(naive - offsetMs(tz, first));
}

/**
 * Today's date in `tz`, as [year, month, day].
 *
 * Read from formatToParts rather than by splitting a formatted string:
 * splitting assumes the locale puts the parts in that order with that
 * separator, which is a thing that varies, and `noUncheckedIndexedAccess`
 * is right to point out that indexing the result proves nothing.
 */
function todayIn(tz: string, now: Date): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return [get("year"), get("month"), get("day")];
}

/** True if `value` is a timezone this runtime actually knows. */
function knownZone(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` string from the URL, or null if it is not one. */
function parseYmd(value: string | undefined): [number, number, number] | null {
  if (!value) return null;
  const match = DATE_RE.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  return [Number(year), Number(month), Number(day)];
}

/**
 * Turn the URL's `range`/`from`/`to` into a period. Never throws: a
 * malformed date in the address bar produces today's figures, not an
 * error page.
 */
export function resolvePeriod(
  params: { range?: string; from?: string; to?: string },
  timezone: string | null | undefined,
  now: Date = new Date()
): Period {
  const tz = knownZone(timezone) ? timezone : "Africa/Accra";
  const [y, m, d] = todayIn(tz, now);
  const startOfToday = fromZoned(tz, y, m, d);
  const startOfTomorrow = fromZoned(tz, y, m, d + 1);

  // A custom range only counts if both ends are real dates and the
  // period is the right way round.
  const fromParts = parseYmd(params.from);
  const toParts = parseYmd(params.to);
  if (fromParts && toParts) {
    const from = fromZoned(tz, fromParts[0], fromParts[1], fromParts[2]);
    const to = fromZoned(tz, toParts[0], toParts[1], toParts[2] + 1);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && to > from) {
      const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
      return {
        range: "custom",
        from,
        to,
        bucket: days <= 1 ? "hour" : days <= 62 ? "day" : days <= 400 ? "week" : "month",
        timezone: tz,
        // Built from the parsed dates, not the raw query string: it is
        // what a person will read on the page, and `to` is exclusive, so
        // the last instant inside the range is the day they asked for.
        label: `${from.toLocaleDateString("en-GB", {
          timeZone: tz,
          day: "numeric",
          month: "short",
        })} to ${new Date(to.getTime() - 1).toLocaleDateString("en-GB", {
          timeZone: tz,
          day: "numeric",
          month: "short",
        })}`,
      };
    }
  }

  const range = (RANGES.find((r) => r.value === params.range)?.value ?? "today") as RangeValue;

  switch (range) {
    case "week":
      return {
        range,
        from: fromZoned(tz, y, m, d - 6),
        to: startOfTomorrow,
        bucket: "day",
        timezone: tz,
        label: "the last 7 days",
      };
    case "month":
      return {
        range,
        from: fromZoned(tz, y, m, 1),
        to: startOfTomorrow,
        bucket: "day",
        timezone: tz,
        label: "this month",
      };
    case "quarter":
      return {
        range,
        from: fromZoned(tz, y, m, d - 89),
        to: startOfTomorrow,
        bucket: "week",
        timezone: tz,
        label: "the last 90 days",
      };
    case "year":
      return {
        range,
        from: fromZoned(tz, y, 1, 1),
        to: startOfTomorrow,
        bucket: "month",
        timezone: tz,
        label: "this year",
      };
    case "today":
    default:
      return {
        range: "today",
        from: startOfToday,
        to: startOfTomorrow,
        bucket: "hour",
        timezone: tz,
        label: "today",
      };
  }
}

/** How a bucket start should read on the chart's axis. */
export function bucketLabel(iso: string, bucket: Period["bucket"], timezone: string): string {
  const date = new Date(iso);
  const base: Intl.DateTimeFormatOptions = { timeZone: timezone };
  switch (bucket) {
    case "hour":
      return date.toLocaleTimeString("en-GB", { ...base, hour: "2-digit", minute: "2-digit" });
    case "month":
      return date.toLocaleDateString("en-GB", { ...base, month: "short" });
    case "week":
    case "day":
    default:
      return date.toLocaleDateString("en-GB", { ...base, day: "numeric", month: "short" });
  }
}