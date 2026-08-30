import { z } from "zod";

/**
 * A numeric form field that refuses to treat "nothing" as zero.
 *
 * `z.coerce.number()` is the obvious way to parse a number out of a
 * FormData value, and it is quietly dangerous here: it is `Number(input)`
 * underneath, and `Number("")`, `Number("   ")` and `Number(null)` are
 * all `0` — a finite, perfectly valid-looking zero. So a field the user
 * left blank, or one a malformed submission omitted entirely, arrives at
 * the database as a deliberate zero.
 *
 * For a "quantity received" field that is merely annoying (a zero is
 * rejected further down for being non-positive). For an absolute value —
 * a stock count, a selling price — it is data loss: a blank stock count
 * silently sets that item's stock to nothing, and a blank selling price
 * silently makes the product free. Both were reachable before this
 * helper existed.
 *
 * This parses explicitly instead: blank is blank, non-numeric is
 * non-numeric, and anything with more precision than the target column
 * stores is rejected rather than being silently rounded by Postgres
 * (so the number the user typed is always the number that gets recorded).
 */
export function decimalField(options: {
  /** Decimal places the destination column stores — numeric(14,2) → 2. */
  decimals: number;
  /** Shown when the field is blank or missing. */
  requiredMessage?: string;
  /** Shown when the value isn't a number at all. */
  invalidMessage?: string;
}) {
  const { decimals, requiredMessage = "Enter a number", invalidMessage = "Enter a number" } = options;

  return z
    .union([z.string(), z.number()], { errorMap: () => ({ message: requiredMessage }) })
    .transform((value, ctx) => {
      const text = typeof value === "number" ? String(value) : value.trim();

      if (text.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: requiredMessage });
        return z.NEVER;
      }

      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: invalidMessage });
        return z.NEVER;
      }

      // Guard against more precision than the column can hold. The 1e-6
      // tolerance is for binary floating point: 2.5 * 100 is not exactly
      // 250 in IEEE 754, and an exact comparison would reject valid input.
      const factor = 10 ** decimals;
      if (Math.abs(parsed * factor - Math.round(parsed * factor)) > 1e-6) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: decimals === 0 ? "Enter a whole number" : `At most ${decimals} decimal places`,
        });
        return z.NEVER;
      }

      return parsed;
    });
}
