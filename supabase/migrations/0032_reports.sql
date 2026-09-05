-- Busihub — 0032: reports (Phase 14)
--
-- Three aggregates the dashboard did not need but a report does.
--
-- WHAT THIS FILE DOES NOT DO
--
-- It does not recompute anything that already exists. profit_and_loss()
-- below is built out of sales_summary() (0029) and expense_summary()
-- (0031) rather than re-deriving sales and costs from the tables. Two
-- definitions of "net sales" is two definitions that eventually
-- disagree, and the day they disagree is the day a shopkeeper stops
-- trusting both. If the P&L and the dashboard ever differ, it will be
-- because someone changed one function — not because two hand-written
-- queries drifted.
--
-- DATES IN, INSTANTS INSIDE
--
-- A report is asked for in days: "August", "1st to the 15th". But a sale
-- happens at an INSTANT and an expense is booked to a DAY, so the two
-- halves are filtered differently and the day boundaries have to be
-- resolved in the shop's own timezone before either can be. Ghana is
-- UTC+0, so getting this wrong would look correct here and be wrong for
-- the first business anywhere else — on the report they show their bank.
--
-- SECURITY INVOKER throughout, like every other reporting function in
-- Busihub, so RLS decides what is counted. tests/security/reports.sql
-- asserts that from the catalog as well as through its effects.

-- ── 1. Profit and loss ───────────────────────────────────────────────────
--
-- The statement an accountant, a bank or a landlord asks for, and the
-- first place in Busihub where the whole chain is visible at once:
--
--   gross sales − refunds            = net sales
--   net sales − cost of goods sold   = gross profit
--   gross profit − expenses          = net profit
--
-- Cost of goods is what the goods cost WHEN THEY WERE SOLD (0029), not
-- what the same goods cost today. That distinction is the reason 0029
-- exists and it is what makes this statement stable: running August's
-- P&L in November must produce August's answer.

create or replace function profit_and_loss(
  p_from date,
  p_to date,
  p_branch_id uuid default null,
  p_timezone text default 'Africa/Accra'
)
returns table (
  gross_sales numeric,
  refunds numeric,
  net_sales numeric,
  cost_of_goods numeric,
  gross_profit numeric,
  expense_total numeric,
  net_profit numeric,
  sale_count bigint,
  items_sold numeric,
  expense_count bigint,
  cash_expenses numeric,
  any_cost_estimated boolean
)
language plpgsql
stable
as $$
declare
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
begin
  if p_from is null or p_to is null then
    raise exception 'A profit and loss statement needs a start and an end date' using errcode = '22023';
  end if;
  if p_to < p_from then
    raise exception 'The end date comes before the start date' using errcode = '22023';
  end if;

  -- An unknown zone would raise mid-query and surface as a database
  -- error on a report page. Fall back instead: a boundary an hour out is
  -- a small inaccuracy, a broken page is not.
  select name into v_tz from pg_timezone_names where name = p_timezone;
  v_tz := coalesce(v_tz, 'Africa/Accra');

  -- p_to is INCLUSIVE — "1st to the 31st" means all of the 31st — so the
  -- instant range ends at midnight the following morning, which is what
  -- sales_summary treats as exclusive.
  v_from := (p_from::timestamp) at time zone v_tz;
  v_to := ((p_to + 1)::timestamp) at time zone v_tz;

  return query
  select
    s.gross_total,
    s.refunded_total,
    s.net_total,
    s.cost_total,
    s.gross_profit,
    e.expense_total,
    s.gross_profit - e.expense_total,
    s.sale_count,
    s.items_sold,
    e.expense_count,
    e.cash_paid_out,
    s.any_cost_estimated
  from sales_summary(v_from, v_to, null, p_branch_id) s,
       expense_summary(p_from, p_to, p_branch_id) e;
end;
$$;

grant execute on function profit_and_loss(date, date, uuid, text) to authenticated;

comment on function profit_and_loss(date, date, uuid, text) is
  'Sales, cost of goods, gross profit, expenses and net profit for a period. Composed from sales_summary() and expense_summary() so it can never disagree with the dashboard. Runs as the caller.';

-- ── 2. Who owes you, and for how long ────────────────────────────────────
--
-- The report that gets money back into the till. A single "owes GH₵400"
-- does not tell a shopkeeper who to ring; GH₵400 owed since May is a
-- different conversation from GH₵400 owed on Tuesday.
--
-- PAYMENTS SETTLE THE OLDEST CHARGE FIRST.
--
-- That is the assumption this whole report rests on, and it is worth
-- being explicit about because the alternative is defensible too. The
-- customer_account_entries ledger (0017) does not record WHICH charge a
-- payment was against — it is a running account, which is how these
-- accounts actually work in a shop: someone pays "GH₵50 off what I owe",
-- not "GH₵50 against the bag of rice from the 3rd".
--
-- So the allocation has to be chosen, and oldest-first is the standard
-- one (and the kinder one: it is what stops a customer who pays
-- regularly from appearing to have 90-day debt forever). The arithmetic
-- is a running total: a charge is unpaid to the extent that the money
-- paid so far has not yet reached it.
--
-- Anyone in CREDIT is absent, not shown as a negative. They are not a
-- debt, and letting them offset the total would understate what the shop
-- is owed by everyone else — the same trap dashboard_snapshot avoids.

create or replace function receivables_aging(
  p_as_of date default null,
  p_timezone text default 'Africa/Accra'
)
returns table (
  customer_id uuid,
  customer_name text,
  phone text,
  total_owed numeric,
  current_amount numeric,
  days_30 numeric,
  days_60 numeric,
  days_90_plus numeric,
  oldest_unpaid date,
  credit_limit numeric
)
language plpgsql
stable
as $$
declare
  v_tz text;
  v_as_of date;
  v_cutoff timestamptz;
begin
  select name into v_tz from pg_timezone_names where name = p_timezone;
  v_tz := coalesce(v_tz, 'Africa/Accra');
  v_as_of := coalesce(p_as_of, (now() at time zone v_tz)::date);
  -- Everything up to the end of the as-of day.
  v_cutoff := ((v_as_of + 1)::timestamp) at time zone v_tz;

  return query
  with entries as (
    select e.customer_id, e.amount, e.created_at
    from customer_account_entries e
    where e.created_at < v_cutoff
  ),
  paid as (
    select en.customer_id, coalesce(sum(-en.amount), 0) as amount
    from entries en
    where en.amount < 0
    group by en.customer_id
  ),
  charges as (
    select
      en.customer_id,
      en.amount,
      (en.created_at at time zone v_tz)::date as charged_on,
      -- How much had been charged by the end of this row, oldest first.
      sum(en.amount) over (
        partition by en.customer_id
        order by en.created_at, en.amount
        rows between unbounded preceding and current row
      ) as running_total
    from entries en
    where en.amount > 0
  ),
  unpaid as (
    select
      c.customer_id,
      c.charged_on,
      -- The money paid so far covers charges in order. This charge is
      -- unpaid only for the part of it that the payments have not
      -- reached — never less than nothing, never more than the charge.
      greatest(0, least(c.amount, c.running_total - coalesce(p.amount, 0))) as owing
    from charges c
    left join paid p on p.customer_id = c.customer_id
  )
  select
    cu.id,
    cu.name,
    cu.phone,
    sum(u.owing),
    coalesce(sum(u.owing) filter (where v_as_of - u.charged_on < 30), 0),
    coalesce(sum(u.owing) filter (where v_as_of - u.charged_on between 30 and 59), 0),
    coalesce(sum(u.owing) filter (where v_as_of - u.charged_on between 60 and 89), 0),
    coalesce(sum(u.owing) filter (where v_as_of - u.charged_on >= 90), 0),
    min(u.charged_on) filter (where u.owing > 0),
    cu.credit_limit
  from unpaid u
  join customers cu on cu.id = u.customer_id
  where u.owing > 0
  group by cu.id, cu.name, cu.phone, cu.credit_limit
  -- Oldest debt first: that is the call to make this morning.
  order by min(u.charged_on) filter (where u.owing > 0), sum(u.owing) desc;
end;
$$;

grant execute on function receivables_aging(date, text) to authenticated;

comment on function receivables_aging(date, text) is
  'Every customer in debt, split into current / 30 / 60 / 90+ days, oldest first. Payments settle the oldest charge first, because the ledger records a running account rather than payments against specific charges. Customers in credit are omitted, not netted off. Runs as the caller.';

-- ── 3. What the stock is worth ───────────────────────────────────────────
--
-- Two numbers per line, and they answer different questions:
--
--   cost value   — money currently sitting on the shelves. What the shop
--                  would lose in a fire, and what it tied up to get here.
--   retail value — what it would come to if every unit sold at today's
--                  price. NOT a forecast: nothing sells at 100%.
--
-- These use the CURRENT catalog price on purpose, which is the opposite
-- of what cost_of_goods does. That is not an inconsistency: a past sale's
-- profit must never move (0029), but stock in hand is worth what it is
-- worth TODAY. Same two columns, two different questions.
--
-- Negative stock is included rather than clamped. It should not happen,
-- and when it does, a valuation that quietly hides it is worse than one
-- that shows a line reading -3.

create or replace function stock_valuation(
  p_branch_id uuid default null,
  p_limit int default 200
)
returns table (
  variant_id uuid,
  product_name text,
  sku text,
  branch_id uuid,
  branch_name text,
  quantity numeric,
  cost_price numeric,
  selling_price numeric,
  cost_value numeric,
  retail_value numeric
)
language sql
stable
as $$
  select
    sl.variant_id,
    p.name,
    v.sku,
    sl.branch_id,
    b.name,
    sl.quantity,
    v.cost_price,
    v.selling_price,
    round(sl.quantity * v.cost_price, 2),
    round(sl.quantity * v.selling_price, 2)
  from stock_levels sl
  join product_variants v on v.id = sl.variant_id
  join products p on p.id = v.product_id
  join branches b on b.id = sl.branch_id
  where v.status = 'active'
    and p.status = 'active'
    and sl.quantity <> 0
    and (p_branch_id is null or sl.branch_id = p_branch_id)
  order by round(sl.quantity * v.cost_price, 2) desc, p.name
  limit least(greatest(coalesce(p_limit, 200), 1), 2000);
$$;

grant execute on function stock_valuation(uuid, int) to authenticated;

comment on function stock_valuation(uuid, int) is
  'Stock on hand valued at today''s cost and today''s selling price, biggest holding first. Runs as the caller.';

-- The totals are their own function for the reason every total in
-- Busihub is: a page shows 200 lines and a shop may have 3,000, and
-- adding up the visible ones would report a stockroom worth a fraction
-- of what is in it.

create or replace function stock_valuation_totals(p_branch_id uuid default null)
returns table (
  variant_count bigint,
  unit_count numeric,
  cost_value numeric,
  retail_value numeric,
  negative_lines bigint
)
language sql
stable
as $$
  select
    count(*)::bigint,
    coalesce(sum(sl.quantity), 0),
    coalesce(sum(round(sl.quantity * v.cost_price, 2)), 0),
    coalesce(sum(round(sl.quantity * v.selling_price, 2)), 0),
    -- Surfaced deliberately: stock below zero means the ledger and the
    -- shelf disagree, and the valuation is wrong until someone counts.
    count(*) filter (where sl.quantity < 0)::bigint
  from stock_levels sl
  join product_variants v on v.id = sl.variant_id
  join products p on p.id = v.product_id
  where v.status = 'active'
    and p.status = 'active'
    and sl.quantity <> 0
    and (p_branch_id is null or sl.branch_id = p_branch_id);
$$;

grant execute on function stock_valuation_totals(uuid) to authenticated;

comment on function stock_valuation_totals(uuid) is
  'What the whole stockroom is worth, at cost and at retail, over every line rather than the page being shown. Also counts lines in negative stock, which mean the ledger and the shelf disagree. Runs as the caller.';