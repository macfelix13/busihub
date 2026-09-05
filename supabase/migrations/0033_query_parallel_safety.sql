-- Busihub — 0033: let the planner parallelize RLS-scoped scans
--
-- WHAT WAS ACTUALLY MEASURED (not guessed)
--
-- Every RLS policy in this database goes through one of six small,
-- read-only, security-definer helper functions: app_current_business_id(),
-- app_is_super_admin(), app_has_permission(), app_has_branch_permission(),
-- app_accessible_branch_ids() (0008), and business_momo_enabled() (0025).
-- Postgres will not run a query in parallel if ANY function it touches is
-- not explicitly marked PARALLEL SAFE, and a function's default — the one
-- every function in this database has had until now — is PARALLEL UNSAFE.
-- So every single query against every RLS-protected table in Busihub has
-- been forced onto a single CPU core, no matter how large the table gets.
--
-- This was found and measured, not assumed: seeded a throwaway database
-- with 300,000 sale_payments rows (a plausible size for a shop after a
-- couple of years of trading) and ran EXPLAIN ANALYZE on
-- payment_method_breakdown() — one of the dashboard's own queries — as an
-- ordinary signed-in user, with Postgres's cost settings tuned the way a
-- managed instance actually is (random_page_cost 1.1, not the 4.0 a local
-- default assumes for a spinning disk):
--
--   before: Seq Scan (single worker)                         — 1.77s
--   after:  Parallel Seq Scan, 2 workers launched             — 0.45s
--
-- Marking these six functions PARALLEL SAFE is what produced that second
-- number. All six are read-only, take no locks, write nothing, and behave
-- identically no matter which process runs them — exactly what PARALLEL
-- SAFE promises. This is the correct, safe fix for that specific gap.
--
-- WHAT THIS MIGRATION DOES NOT FIX
--
-- The same investigation also tried to fix payment_method_breakdown()
-- (and by the same construction, every other dashboard/report function
-- that filters sale_payments or sales by date) with a matching index —
-- on the reasonable theory that "last 30 days" should only ever have to
-- touch 30 days of rows, not the whole table's history.
--
-- It does not. Every index shape tried (a plain composite index, a
-- partial index scoped to status = 'success', with and without a
-- coalesce()-rewritten WHERE clause instead of the "column is null or ..."
-- form used throughout 0027-0032) produced the exact same result: as
-- soon as app_has_permission()'s OR-chain sits in the same WHERE clause,
-- Postgres stops using the date columns as an index condition at all and
-- falls back to filtering them row-by-row after the fact. Proven by
-- removing the RLS predicate and watching the SAME index immediately
-- start being used correctly (an Index Only Scan, sub-2ms) — so the index
-- shape is right and the planner interaction with this RLS pattern is
-- the actual blocker. That is a real, structural limitation of combining
-- Postgres RLS with a security-definer permission check across a JOIN,
-- not something a CREATE INDEX in this migration can paper over.
--
-- Practically: every dashboard and report query that touches sale_payments
-- or sales scales with the TOTAL number of historical rows in that table,
-- not with the size of the period actually asked for. At 300k rows that
-- is under two seconds even for "today"; it will keep growing as a shop's
-- history grows. Flagged here, with the numbers, rather than left for
-- someone to rediscover the hard way. The honest fix is architectural —
-- most plausibly a periodic rollup/summary table for closed periods, or
-- partitioning sales/sale_payments by month — and is real enough work
-- that it belongs in its own migration once a business's data actually
-- reaches a size where it matters, not bundled into a parallel-safety fix.

alter function app_current_business_id() parallel safe;
alter function app_is_super_admin() parallel safe;
alter function app_has_permission(uuid, text) parallel safe;
alter function app_has_branch_permission(uuid, text) parallel safe;
alter function app_accessible_branch_ids(uuid) parallel safe;
alter function business_momo_enabled(uuid) parallel safe;

comment on function app_has_permission(uuid, text) is
  'Business-level permission check used by nearly every RLS policy in this database. Marked PARALLEL SAFE (0033) so Postgres can still parallelize a large scan on a table this function guards — it is a pure read with no side effects, so this changes performance, never behaviour.';
