-- Busihub — 0028: the four numbers a shopkeeper opens the app to see
--
-- Same reasoning as sales_summary() in 0027, for the same reason: each of
-- these is a total over a whole table, and computing it from whatever
-- rows the page happened to fetch would be quietly wrong. "GH₵400 owed"
-- when it is GH₵4,000 across more customers than fit on a page is not a
-- smaller truth, it is a false one.
--
-- SECURITY INVOKER (the default), so RLS decides what is counted. A
-- DEFINER function here would report another business's debts.

create or replace function dashboard_snapshot()
returns table (
  owed_total numeric,
  owing_customers bigint,
  low_stock_count bigint,
  awaiting_payment_count bigint,
  low_stock_threshold numeric
)
language sql
stable
as $$
  with threshold as (
    select coalesce(
      (select (bs.inventory_settings ->> 'low_stock_threshold')::numeric
       from business_settings bs
       limit 1),
      5
    ) as value
  ),
  owing as (
    -- Only customers actually in debt. A customer in credit (they
    -- overpaid, or were refunded to their account) must not quietly
    -- reduce what the shop is owed by everyone else.
    select coalesce(sum(b.balance), 0) as amount, count(*) as people
    from customer_balances b
    where b.balance > 0
  ),
  low as (
    select count(*) as items
    from stock_levels s
    join product_variants v on v.id = s.variant_id
    join products p on p.id = v.product_id
    where s.quantity <= (select value from threshold)
      and v.status = 'active'
      and p.status = 'active'
  ),
  waiting as (
    select count(*) as sales
    from sales s
    where s.status = 'awaiting_payment'
  )
  select
    (select amount from owing),
    (select people from owing),
    (select items from low),
    (select sales from waiting),
    (select value from threshold);
$$;

grant execute on function dashboard_snapshot() to authenticated;

comment on function dashboard_snapshot() is
  'The dashboard''s counts in one round trip: what customers owe, how many products are at or below the low-stock threshold, and how many sales are still waiting for payment. Runs as the caller, so RLS scopes every figure to their own business.';
