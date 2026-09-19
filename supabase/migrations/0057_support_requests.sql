-- Busihub — 0057: support requests
--
-- A business's own way to reach Busihub support without leaving the app
-- (dashboard "Need help?" card), and the other half of that: a place in
-- the Super Admin console to see what came in and resolve it.
--
-- Same one-table-per-tenant-fact pattern as everywhere else in this
-- schema: business_id/submitted_by are forced server-side by the trigger
-- below, from the caller's own session, never trusted from client input
-- — so a request can never be filed against, or read as having come
-- from, a business other than the sender's own (see set_support_request_
-- sender()'s comment, and set_product_variant_business_id() in 0013 for
-- the precedent this follows).
--
-- Deliberately NOT gated behind a specific permission on insert — asking
-- for help isn't a privileged business operation the way editing a
-- product or processing a sale is; any signed-in member of a business
-- can send one.
--
-- No delete policy — a support request is a record of what was asked and
-- when, same as audit_logs and every other history table in this schema.

create table support_requests (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  submitted_by uuid references profiles(id) on delete set null,
  message      text not null check (char_length(trim(message)) > 0),
  status       text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by  uuid references profiles(id) on delete set null,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index support_requests_business_id_idx on support_requests (business_id);
create index support_requests_status_idx on support_requests (status);

comment on table support_requests is
  'A message a business sent to Busihub support from its dashboard. business_id/submitted_by are forced server-side by set_support_request_sender() below, never trusted from client input.';

create or replace function set_support_request_sender()
returns trigger
language plpgsql
as $$
begin
  new.business_id := app_current_business_id();
  new.submitted_by := auth.uid();

  if new.business_id is null then
    raise exception 'Not linked to a business' using errcode = 'P0001';
  end if;

  -- A fresh request is always open, regardless of what a client sends —
  -- resolving one is a Super Admin action (support_requests_update
  -- below), never something the sender sets at submit time.
  new.status := 'open';
  new.resolved_by := null;
  new.resolved_at := null;

  return new;
end;
$$;

comment on function set_support_request_sender() is
  'Forces business_id/submitted_by to the caller''s own session, and status/resolved_* to their just-submitted defaults, regardless of what a client sends — same defense-in-depth pattern as set_product_variant_business_id() (0013). Runs BEFORE INSERT so RLS''s WITH CHECK evaluates the corrected values.';

create trigger set_sender
  before insert on support_requests
  for each row execute function set_support_request_sender();

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table support_requests enable row level security;

create policy support_requests_select on support_requests
  for select
  using (business_id = app_current_business_id() or app_is_super_admin());

create policy support_requests_insert on support_requests
  for insert
  with check (business_id = app_current_business_id());

-- Only a Super Admin resolves one — a business can see its own requests
-- (support_requests_select above) but never edit them once sent.
create policy support_requests_update on support_requests
  for update
  using (app_is_super_admin())
  with check (app_is_super_admin());

-- No explicit GRANT needed here — 0009's `alter default privileges`
-- already covers every table created after it, `authenticated` included.
-- RLS above is what actually narrows access; the DELETE grant that comes
-- along with that default is simply never matched by a policy, so it has
-- no effect (same "no delete policy" reasoning as products, 0013).