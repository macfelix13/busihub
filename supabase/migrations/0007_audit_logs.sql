-- Busihub — 0007: audit_logs
--
-- Append-only. Rows are written exclusively through the log_audit_event()
-- function (0008), which is what every permission-checking / mutating
-- code path calls — so "was this action authorized" and "was this action
-- logged" cannot drift apart (Section 28).

create table audit_logs (
  id            uuid primary key default gen_random_uuid(),
  -- Null business_id = platform-level event (e.g. Super Admin action).
  business_id   uuid references businesses(id) on delete set null,
  branch_id     uuid references branches(id) on delete set null,
  actor_user_id uuid references profiles(id) on delete set null,
  action        text not null,           -- e.g. 'sale.refund', 'user.role_changed'
  resource_type text not null,           -- e.g. 'sale', 'product', 'user'
  resource_id   uuid,
  metadata      jsonb not null default '{}'::jsonb,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);

create index audit_logs_business_id_created_at_idx on audit_logs (business_id, created_at desc);
create index audit_logs_resource_idx on audit_logs (resource_type, resource_id);
create index audit_logs_actor_idx on audit_logs (actor_user_id);

comment on table audit_logs is 'Append-only. No UPDATE/DELETE policy is granted to any application role — see 0008 RLS. Retention/purge, if ever needed, is a service-role-only operation, documented in docs/SECURITY.md.';
