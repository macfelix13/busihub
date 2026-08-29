-- Busihub — 0001: extensions & shared helpers
-- Foundation for every later migration. Safe to re-run (IF NOT EXISTS).

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "citext";     -- case-insensitive email/text

-- Generic "touch updated_at" trigger function reused by every table below
-- that has an updated_at column, instead of hand-rolling one per table.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function set_updated_at() is
  'Trigger function: sets updated_at = now() on every UPDATE. Attach with:
   create trigger set_updated_at before update on <table>
   for each row execute function set_updated_at();';
