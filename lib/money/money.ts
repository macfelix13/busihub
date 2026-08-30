/**
 * Decimal-safe money helpers (Section 22: never use floating point for
 * anything that touches a price, total, or balance).
 *
 * We represent money as integer minor units (pesewas for GHS, cents for
 * most other currencies) inside all arithmetic, and only format to a
 * decimal string at the boundary (UI/receipts). This sidesteps
 * `0.1 + 0.2 !== 0.3`-class bugs entirely rather than trying to round our
 * way out of them after the fact.
 *
 * Postgres-side, the equivalent guarantee comes from every monetary
 * column being `numeric(14,2)` (see supabase/migrations) rather than
 * `float`/`double precision`.
 */

/**
 * PostgREST (what supabase-js talks to) serializes Postgres `numeric`
 * columns as JSON strings, not numbers — deliberately, to avoid silent
 * float precision loss over the wire — while `int`/`real`/`double
 * precision` columns come back as actual JSON numbers. Every
 * numeric(14,2) money column in this schema (product prices, subscription
 * plan prices, …) therefore needs this before arithmetic/formatting;
 * skipping it fails oddly, since `Number.isFinite("12.50")` is false
 * (strict, non-coercing) even though the value is perfectly usable.
 */
export function toNumber(value: number | string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) {
    throw new Error(`toNumber: value must be finite, got ${value}`);
  }
  return n;
}

/** Convert a decimal amount (e.g. from a form input, or a numeric(14,2) column read via supabase-js — see toNumber()) to integer minor units. */
export function toMinorUnits(amount: number | string): number {
  const n = toNumber(amount);
  // Round at the cent level before converting, so floating point
  // representation error in `amount` itself can't leak through.
  return Math.round(n * 100);
}

/** Convert integer minor units back to a decimal number for display. */
export function fromMinorUnits(minorUnits: number): number {
  return minorUnits / 100;
}

/** Format minor units as a currency string, e.g. formatMoney(12345, "GHS") -> "GH₵123.45". */
const CURRENCY_SYMBOLS: Record<string, string> = {
  GHS: "GH₵",
  USD: "$",
  EUR: "€",
  GBP: "£",
  NGN: "₦",
};

export function formatMoney(minorUnits: number, currencyCode: string): string {
  const symbol = CURRENCY_SYMBOLS[currencyCode] ?? `${currencyCode} `;
  const amount = fromMinorUnits(minorUnits);
  return `${symbol}${amount.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export type DiscountType = "percentage" | "fixed";

export interface DiscountInput {
  type: DiscountType;
  /** Percentage as a whole number (5 = 5%), or minor units for a fixed discount. */
  value: number;
}

/**
 * Computes the discount amount in minor units for a given subtotal.
 * A percentage discount is computed against the subtotal and rounded to
 * the nearest minor unit; never allowed to exceed the subtotal itself
 * (a discount can't make a line item negative).
 */
export function calculateDiscountAmount(subtotalMinorUnits: number, discount: DiscountInput): number {
  if (subtotalMinorUnits < 0) {
    throw new Error("calculateDiscountAmount: subtotal cannot be negative");
  }

  let amount: number;
  if (discount.type === "percentage") {
    if (discount.value < 0 || discount.value > 100) {
      throw new Error("calculateDiscountAmount: percentage discount must be between 0 and 100");
    }
    amount = Math.round((subtotalMinorUnits * discount.value) / 100);
  } else {
    if (discount.value < 0) {
      throw new Error("calculateDiscountAmount: fixed discount cannot be negative");
    }
    amount = Math.round(discount.value);
  }

  return Math.min(amount, subtotalMinorUnits);
}

/**
 * Server-side discount authorization check (Section 14). The caller's
 * role carries a maximum discount percentage; this rejects (rather than
 * silently clamping) any discount that exceeds it, so the caller must
 * either reduce the discount or route it through the approval workflow.
 * The percentage cap is compared against the discount's *effective*
 * percentage of the subtotal, so a fixed-amount discount is checked on
 * equal footing with a percentage one.
 */
export function isDiscountWithinCap(
  subtotalMinorUnits: number,
  discount: DiscountInput,
  maxDiscountPercent: number
): boolean {
  if (subtotalMinorUnits <= 0) return true;
  const amount = calculateDiscountAmount(subtotalMinorUnits, discount);
  const effectivePercent = (amount / subtotalMinorUnits) * 100;
  // Small epsilon to absorb rounding, not to widen the cap meaningfully.
  return effectivePercent <= maxDiscountPercent + 0.01;
}

export interface TaxBreakdown {
  vat: number;
  nhilLevy: number;
  getfundLevy: number;
  covidLevy: number;
  total: number;
}

/**
 * Ghana VAT/NHIL/GETFund/COVID levy calculation. Ghana's standard
 * treatment (as of this writing) applies NHIL, GETFund, and the COVID-19
 * levy on the taxable value BEFORE VAT, then VAT is charged on top of
 * that combined amount — i.e. the levies are not themselves subject to
 * VAT, but VAT is computed on (price + levies), not on price alone. Rates
 * are read from business_settings.tax_settings (never hardcoded), passed
 * in here as parameters so this function stays a pure, easily-tested
 * calculation.
 */
export function calculateGhanaTax(
  taxableAmountMinorUnits: number,
  rates: { vatRate: number; nhilLevyRate: number; getfundLevyRate: number; covidLevyRate: number }
): TaxBreakdown {
  if (taxableAmountMinorUnits < 0) {
    throw new Error("calculateGhanaTax: taxable amount cannot be negative");
  }

  const nhilLevy = Math.round(taxableAmountMinorUnits * rates.nhilLevyRate);
  const getfundLevy = Math.round(taxableAmountMinorUnits * rates.getfundLevyRate);
  const covidLevy = Math.round(taxableAmountMinorUnits * rates.covidLevyRate);
  const vatBase = taxableAmountMinorUnits + nhilLevy + getfundLevy + covidLevy;
  const vat = Math.round(vatBase * rates.vatRate);

  return {
    vat,
    nhilLevy,
    getfundLevy,
    covidLevy,
    total: vat + nhilLevy + getfundLevy + covidLevy,
  };
}

