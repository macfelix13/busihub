-- Busihub — regression test for 0033 (query parallel safety).
--
-- The fix in 0033 is one word per function (PARALLEL SAFE) and entirely
-- invisible in behaviour — every existing suite already proves these
-- functions still return the right, correctly-scoped answers, because
-- PARALLEL SAFE changes nothing about what a function returns. What it
-- does not catch is someone re-running `create or replace function` on
-- one of these six later (a permission-model change, a bug fix) without
-- remembering to keep the parallel-safety declaration, silently undoing
-- the whole point of this migration. So this checks the catalog
-- directly, the same way the reporting functions are checked for an
-- accidental SECURITY DEFINER elsewhere in this suite, rather than
-- trying to infer it from a timing measurement that would be flaky in CI.
--
-- `TEST FAILED` raises carry SQLSTATE ZZ999, which no handler catches.

\set ON_ERROR_STOP on
\pset format aligned

do $$
declare
  v_not_safe text;
begin
  select string_agg(p.proname || '/' || pg_get_function_identity_arguments(p.oid), ', ')
  into v_not_safe
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in (
      'app_current_business_id',
      'app_is_super_admin',
      'app_has_permission',
      'app_has_branch_permission',
      'app_accessible_branch_ids',
      'business_momo_enabled'
    )
    and p.proparallel <> 's';

  if v_not_safe is not null then
    raise exception 'TEST FAILED: expected all six RLS helper functions to be PARALLEL SAFE (0033), but these are not: %', v_not_safe
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: all six RLS helper functions are declared PARALLEL SAFE';
end $$;

-- And the reverse mistake — marking something PARALLEL SAFE that
-- actually writes — is just as worth catching. None of Busihub's
-- mutating RPCs (create_sale, void_expense, and the rest all end in a
-- verb, not a getter) should ever pick this up, so this is a permanent
-- assertion, not a one-time check: any function that writes and is
-- marked PARALLEL SAFE is either mis-marked or, worse, doesn't actually
-- need SECURITY DEFINER's authority and is a bug in the other direction.
do $$
declare
  v_wrongly_safe text;
begin
  select string_agg(p.proname || '/' || pg_get_function_identity_arguments(p.oid), ', ')
  into v_wrongly_safe
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proparallel = 's'
    and p.provolatile = 'v'; -- volatile: the marker every writer in this codebase uses (language plpgsql mutating functions)

  if v_wrongly_safe is not null then
    raise exception 'TEST FAILED: found VOLATILE (mutating) function(s) marked PARALLEL SAFE, which should never happen in this codebase: %', v_wrongly_safe
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: no mutating function is mismarked PARALLEL SAFE';
end $$;
