-- Busihub — 0006: subscription_plans, business_subscriptions
--
-- Centralized entitlement system (Section 32): plan limits/features live
-- in subscription_plans.limits as jsonb and are read at runtime by
-- lib/entitlements — nothing in application code hardcodes "max 3
-- branches" or similar. See docs/ARCHITECTURE.md §9.

create table subscription_plans (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,           -- e.g. 'trial', 'starter', 'growth'
  name             text not null,
  description      text,
  price_amount     numeric(14,2) not null default 0 check (price_amount >= 0),
  currency_code    text not null default 'GHS',
  billing_interval text not null default 'month' check (billing_interval in ('month', 'year', 'none')),
  -- Everything a plan gates lives here, e.g.:
  -- {"max_users": 5, "max_branches": 1, "max_products": 500,
  --  "max_pos_terminals": 2, "storage_mb": 500,
  --  "features": {"advanced_reports": false, "api_access": false}}
  limits           jsonb not null default '{}'::jsonb,
  is_active        boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger set_updated_at
  before update on subscription_plans
  for each row execute function set_updated_at();

comment on table subscription_plans is 'Platform-level plan catalog. Managed by Super Admin only. limits jsonb is the single source of truth for every plan gate — never hardcode a limit in application code.';

create type subscription_status as enum ('trialing', 'active', 'past_due', 'suspended', 'cancelled', 'expired');

create table business_subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null unique references businesses(id) on delete cascade,
  plan_id             uuid not null references subscription_plans(id),
  status              subscription_status not null default 'trialing',
  trial_ends_at       timestamptz,
  current_period_start timestamptz not null default now(),
  current_period_end   timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index business_subscriptions_status_idx on business_subscriptions (status);

create trigger set_updated_at
  before update on business_subscriptions
  for each row execute function set_updated_at();

comment on table business_subscriptions is 'Current subscription state per business. Written only by trusted server-side billing logic (service role) — never directly by tenant users, even Owners, since this is the enforcement boundary for paid features.';
