-- Busihub — 0002: businesses & business_settings
-- The tenancy root. Every other tenant table hangs off businesses.id.

create type business_status as enum ('active', 'suspended', 'closed');

create table businesses (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (char_length(trim(name)) > 0),
  slug              citext not null unique,
  business_type     text,                          -- e.g. 'retail', 'restaurant', 'pharmacy'
  logo_url          text,
  email             citext,
  phone             text,
  address_line1     text,
  address_line2     text,
  city              text,
  region            text,                           -- e.g. Ghanaian region
  country_code      text not null default 'GH',     -- ISO 3166-1 alpha-2
  currency_code     text not null default 'GHS',     -- ISO 4217
  status            business_status not null default 'active',
  created_by        uuid,                            -- profiles.id of the registering owner (FK added after profiles exists)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index businesses_status_idx on businesses (status);

create trigger set_updated_at
  before update on businesses
  for each row execute function set_updated_at();

comment on table businesses is 'Tenancy root. One row per registered business.';
comment on column businesses.slug is 'URL-safe unique identifier, e.g. for a future public storefront/receipt page.';

-- ── business_settings ───────────────────────────────────────────────────
-- 1:1 extension of businesses for configurable, evolving settings groups.
-- Kept separate from the core identity columns above so that settings can
-- grow (new jsonb keys) without repeated ALTER TABLE migrations on the
-- tenancy root table.
create table business_settings (
  business_id           uuid primary key references businesses(id) on delete cascade,
  tax_settings          jsonb not null default '{"vat_enabled": true, "vat_rate": 0.15, "vat_inclusive": true, "nhil_levy_rate": 0.025, "getfund_levy_rate": 0.025, "covid_levy_rate": 0.01}'::jsonb,
  receipt_settings      jsonb not null default '{"footer_message": "Thank you for your business!", "show_logo": true, "show_qr_code": true, "paper_size": "thermal_80mm"}'::jsonb,
  invoice_settings      jsonb not null default '{"prefix": "INV-", "next_number": 1, "due_days": 14}'::jsonb,
  pos_settings          jsonb not null default '{"allow_negative_stock": false, "require_customer_for_sale": false, "default_discount_cap_percent": 5}'::jsonb,
  inventory_settings    jsonb not null default '{"low_stock_threshold": 5, "track_expiry": false, "track_batches": false}'::jsonb,
  notification_settings jsonb not null default '{"low_stock_alerts": true, "daily_summary": true}'::jsonb,
  appearance_settings   jsonb not null default '{"theme": "system", "primary_color": "#22a56d"}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create trigger set_updated_at
  before update on business_settings
  for each row execute function set_updated_at();

comment on table business_settings is
  'Configurable per-business settings, grouped as jsonb so new options do not require schema migrations. Numeric business rules that must be enforced server-side (e.g. discount caps) are still validated in application code, not trusted purely from these values.';
