/**
 * Placeholder hand-written types until `supabase gen types typescript` can
 * be run against a real project (requires the Supabase CLI + a live
 * project connection, neither of which is available in this sandbox — see
 * docs/DEPLOYMENT.md). Regenerate this file as the very first step after
 * connecting a real Supabase project, then delete this notice.
 *
 * Keeping `Database = any` here (instead of hand-maintaining full types)
 * is a deliberate, temporary choice: a hand-maintained type file that
 * silently drifts from the real schema is worse than no types, because it
 * would give false confidence. Every table/column referenced elsewhere in
 * the app is still fully typed at the call site via explicit interfaces in
 * lib/types/*.ts, so this placeholder does not remove type safety from
 * application code — only from the raw Supabase query builder's inference
 * until real generated types replace it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = any;
