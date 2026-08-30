-- Busihub â€” 0012: set_main_branch()
--
-- Exactly one branch per business can have is_main = true (partial unique
-- index, 0003). Swapping which branch is main is therefore two UPDATEs
-- that must happen atomically â€” a UI that did them as two separate
-- requests could crash between them (leaving zero main branches) or race
-- with a concurrent request. Wrapping both in one function makes it a
-- single statement from the caller's point of view; Postgres treats the
-- whole function body as one transaction, so either both UPDATEs apply or
-- neither does.
--
-- Deliberately NOT security definer: it runs with the calling user's own
-- privileges, so the existing branches_select/branches_update RLS
-- policies (0009) â€” which already require business_id =
-- app_current_business_id() and branches.manage â€” apply exactly as they
-- would to two ordinary UPDATE statements. No new authorization logic to
-- keep in sync with those policies. Application code should still call
-- requirePermission(..., 'branches.manage') first for a clean error
-- message (Section 49's defense-in-depth pattern); RLS is the backstop,
-- not the only check.
create or replace function set_main_branch(p_branch_id uuid)
returns void
language plpgsql
as $$
declare
  v_business_id uuid;
begin
  -- RLS-scoped: only resolves if the caller can see this branch at all.
  select business_id into v_business_id from branches where id = p_branch_id;

  if v_business_id is null then
    raise exception 'Branch not found' using errcode = 'P0002';
  end if;

  update branches set is_main = false
    where business_id = v_business_id and is_main and id <> p_branch_id;

  update branches set is_main = true
    where id = p_branch_id;
end;
$$;

comment on function set_main_branch is
  'Atomically swaps which branch is the main branch for its business. Runs as the caller (not security definer) so branches_update RLS (0009) governs it exactly as it would two ordinary UPDATEs.';

grant execute on function set_main_branch(uuid) to authenticated;
