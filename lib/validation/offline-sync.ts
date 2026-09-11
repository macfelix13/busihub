import { z } from "zod";
import { cartLineSchema } from "./sales";
import { decimalField } from "./numeric";

/**
 * Validation for POST /api/sync (Phase 17, migration 0052) — a batch of
 * sales that were rung up while the till had no connection and are now
 * being replayed from the browser's own offline queue.
 *
 * Deliberately narrower than the till's own checkoutSchema:
 *
 *   - No mobile money, and no split. A phone cannot be prompted for a
 *     charge on a connection that did not exist at the moment of sale,
 *     and by the time this batch reaches the server the moment has
 *     passed — 0052 refuses this at the database layer too (a synced
 *     sale naming momo raises P0001), so `paymentMethod` is restricted
 *     here purely to fail fast with a clearer, per-item message rather
 *     than to be the only thing standing in the way.
 *
 *   - clientTransactionId is required on every item. It is what
 *     create_sale()'s idempotency check (0052) is keyed on: the same
 *     queued sale retried after a dropped response, or genuinely
 *     resubmitted, lands exactly once. The route handler trusts this id
 *     no more than any other client input — it is not a secret and
 *     grants no access on its own, it only deduplicates within whatever
 *     business/branch the caller's own session already has sales.process
 *     on.
 *
 * No prices, tax, or totals here either, for the same reason as the till:
 * create_sale() derives all of that itself.
 */

// Reuses decimalField (lib/validation/numeric.ts) rather than a bare
// z.coerce.number() for the same reason the till does: it refuses to
// treat a blank/absent value as a silent zero and rejects more precision
// than the numeric(14,2) column stores, instead of letting Postgres round
// a figure the client never actually sent.
const queuedAmountSchema = z.preprocess(
  (v) => (v === null || v === undefined || v === "" ? 0 : v),
  decimalField({
    decimals: 2,
    requiredMessage: "Enter an amount",
    invalidMessage: "Enter a number",
  }).refine((n) => n >= 0, { message: "Cannot be negative" })
);

export const queuedSaleSchema = z
  .object({
    clientTransactionId: z.string().uuid("Each queued sale needs a client transaction id"),
    branchId: z.string().uuid("Choose a branch"),
    customerId: z.union([z.literal(""), z.string().uuid()]).optional(),
    paymentMethod: z.enum(["cash", "credit"], {
      errorMap: () => ({ message: "Only cash or on-account sales can be synced from offline" }),
    }),
    amountTendered: queuedAmountSchema,
    items: z.array(cartLineSchema).min(1, "A queued sale needs at least one item"),
  })
  .superRefine((data, ctx) => {
    if (data.paymentMethod === "credit" && !data.customerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A synced on-account sale needs a customer.",
        path: ["customerId"],
      });
    }
  });

export type QueuedSaleInput = z.infer<typeof queuedSaleSchema>;

/**
 * Capped well above any real till's offline session (a busy shop rings up
 * a few hundred sales a day at most) — not a hard product limit, just a
 * backstop so one request can't ask the database to work through an
 * unbounded queue.
 */
export const MAX_QUEUED_SALES_PER_BATCH = 200;

export const syncRequestSchema = z.object({
  sales: z
    .array(queuedSaleSchema)
    .min(1, "Nothing to sync")
    .max(MAX_QUEUED_SALES_PER_BATCH, "Too many queued sales in one batch — send fewer at a time"),
});

export type SyncRequestInput = z.infer<typeof syncRequestSchema>;