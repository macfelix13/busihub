-- Busihub — 0053: first-run onboarding checklist
--
-- A brand-new signup currently lands on a dashboard that is all zeros
-- with no guidance on what to do first — no products, no stock, no
-- sales, nothing. This adds the data this checklist needs, computed the
-- same way dashboard_snapshot() (0028) is: a single SECURITY INVOKER
-- function that reads real tables under the caller's own RLS, so it can
-- never report another business's progress and never needs a
-- business_id argument.
--
-- onboarding_settings follows the exact pattern business_settings (0002)
-- already documents for itself: a new jsonb settings group added by
-- migration, so later keys (e.g. per-step dismissal) can be added inside
-- it without another ALTER TABLE.

alter table business_settings
  add column onboarding_settings jsonb not null default '{"dismissed": false}'::jsonb;

comment on column business_settings.onboarding_settings is
  'First-run checklist state. Currently just {"dismissed": bool} — the checklist itself is otherwise fully derived from real data (see onboarding_status()), not tracked here, so it can never claim a step is done when it is not.';

create or replace function onboarding_status()
returns table (
  has_product boolean,
  has_stock boolean,
  has_sale boolean,
  payment_connected boolean,
  has_extra_staff boolean,
  dismissed boolean
)
language sql
stable
as $$
  select
    exists (select 1 from products),
    exists (select 1 from stock_levels where quantity > 0),
    exists (select 1 from sales),
    exists (select 1 from business_payment_settings where configured_at is not null),
    (select count(distinct user_id) from user_branch_roles) > 1,
    coalesce((select (onboarding_settings ->> 'dismissed')::boolean from business_settings limit 1), false);
$$;

grant execute on function onboarding_status() to authenticated;

comment on function onboarding_status() is
  'Five real yes/no facts for the first-run checklist: has this business added a product, gotten any stock in, made a sale, connected Paystack, and added a second staff member — plus whether the checklist has been dismissed. SECURITY INVOKER like dashboard_snapshot(): RLS on each underlying table scopes every check to the caller''s own business, so there is no business_id argument to get wrong.';