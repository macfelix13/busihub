-- Busihub — 0030: the dashboard's analytics, computed in the database
--
-- WHY THESE ARE FUNCTIONS AND NOT PAGE CODE
--
-- Every figure here is an aggregate over a whole table. Computing one in
-- the page means first fetching the rows, which means a page size, which
-- means the answer silently becomes "the total of the first 50 rows".
-- That is not a smaller truth; it is a false one, and a shopkeeper cannot
-- tell the difference by looking. So the aggregates live where the rows
-- do, and the page fetches one row per card.
--
-- WHY EVERY FUNCTION IS SECURITY INVOKER (the default)
--
-- These are the numbers a business would least like another business to
-- see: takings, margins, who sells what, which branch is behind. Running
-- as the caller means Row Level Security decides which rows are counted,
-- so a total is scoped to the caller's own business by the same policies
-- that scope a list. A SECURITY DEFINER function here would bypass RLS
-- and report a neighbour's takings — the tests in tests/security/
-- dashboard.sql fail loudly if any of these is ever changed to DEFINER.
--
-- Note what follows from that: there is no p_business_id argument
-- anywhere in this file. A business id supplied by the browser is not
-- trusted for anything, and there is nothing here for it to widen.
--
-- WHAT IS DELIBERATELY MISSING
--
-- Net profit, expense totals and profit margin after costs are NOT here,
-- because Busihub has no expenses table yet (Phase 13). Gross profit —
-- sales less the cost of the goods sold, which 0029 made real — is here.
-- Publishing a "net profit" that ignores rent, wages and electricity
-- would be a fabricated number on a page a shopkeeper makes decisions
-- from, so it is absent rather than wrong.

-- ── 1. Sales over time ──────────────────────────────────────────────────
--
-- Gap-filled: a day with no sales must appear as a zero, not vanish. A
-- chart that silently drops empty days draws a flat line through a dead
-- week and makes it look like trade continued.
--
-- Bucketed in the shop's own timezone, not UTC. Accra is UTC+0 today, but
-- hard-coding that assumption means the first business in a different
-- zone gets days that start at the wrong hour, and "yesterday's takings"
-- is the figure people check most.

create or replace function sales_trend(
  p_from timestamptz,
  p_to timestamptz default null,
  p_branch_id uuid default null,
  p_bucket text default 'day',
  p_timezone text default 'Africa/Accra'
)
returns table (
  bucket_start timestamptz,
  sale_count bigint,
  net_total numeric,
  gross_profit numeric
)
language plpgsql
stable
as $$
declare
  v_tz text;
  v_to timestamptz := coalesce(p_to, now());
  v_step interval;
begin
  if p_from is null then
    raise exception 'A start date is required' using errcode = '22023';
  end if;
  if p_bucket not in ('hour', 'day', 'week', 'month') then
    raise exception 'Unknown bucket %', p_bucket using errcode = '22023';
  end if;
  -- An unknown zone name would raise mid-query and surface as a database
  -- error on the dashboard. Fall back instead: a chart bucketed in the
  -- default zone is a small inaccuracy, a broken page is not.
  select name into v_tz from pg_timezone_names where name = p_timezone;
  v_tz := coalesce(v_tz, 'Africa/Accra');
  v_step := ('1 ' || p_bucket)::interval;

  return query
  with buckets as (
    select generate_series(
      date_trunc(p_bucket, p_from at time zone v_tz),
      date_trunc(p_bucket, v_to at time zone v_tz),
      v_step
    ) as local_start
  ),
  -- Only completed sales count as trade. A sale still waiting for a momo
  -- prompt is not takings, and a voided one never was.
  sold as (
    select
      date_trunc(p_bucket, s.created_at at time zone v_tz) as local_start,
      count(*) as sales,
      sum(s.total) as amount,
      sum(coalesce(li.cost, 0)) as cost
    from sales s
    left join lateral (
      select sum(si.quantity * si.unit_cost) as cost
      from sale_items si where si.sale_id = s.id
    ) li on true
    where s.status = 'completed'
      and s.created_at >= p_from
      and s.created_at <= v_to
      and (p_branch_id is null or s.branch_id = p_branch_id)
    group by 1
  ),
  -- A return is subtracted from the bucket it was given in, not the one
  -- the sale was in. That is what the drawer actually did that day.
  returned as (
    select
      date_trunc(p_bucket, r.created_at at time zone v_tz) as local_start,
      sum(r.total) as amount,
      sum(coalesce(ri.cost, 0)) as cost
    from refunds r
    left join lateral (
      select sum(x.quantity * x.unit_cost) as cost
      from refund_items x where x.refund_id = r.id
    ) ri on true
    where r.created_at >= p_from
      and r.created_at <= v_to
      and (p_branch_id is null or exists (
        select 1 from sales s where s.id = r.sale_id and s.branch_id = p_branch_id
      ))
    group by 1
  )
  select
    b.local_start at time zone v_tz,
    coalesce(s.sales, 0)::bigint,
    coalesce(s.amount, 0) - coalesce(rt.amount, 0),
    (coalesce(s.amount, 0) - coalesce(rt.amount, 0))
      - (coalesce(s.cost, 0) - coalesce(rt.cost, 0))
  from buckets b
  left join sold s on s.local_start = b.local_start
  left join returned rt on rt.local_start = b.local_start
  order by b.local_start;
end;
$$;

grant execute on function sales_trend(timestamptz, timestamptz, uuid, text, text) to authenticated;

comment on function sales_trend(timestamptz, timestamptz, uuid, text, text) is
  'Completed sales and gross profit per hour/day/week/month, gap-filled so quiet periods show as zero rather than disappearing, bucketed in the shop''s own timezone. Runs as the caller, so RLS scopes it to their business.';

-- ── 2. How people actually paid ─────────────────────────────────────────
--
-- Read from sale_payments — the tender ledger — and not from
-- sales.payment_method, which says "split" without saying how much of it
-- was cash. The question this answers is "how much is in the drawer
-- versus in the momo wallet", and only the ledger can answer it.
--
-- The cash tender row records what was HANDED OVER, change included,
-- because that is what the cashier typed. The change is then handed back,
-- so the money the shop actually kept is the tender less the change on
-- that sale. Reporting the tendered figure would overstate cash by
-- exactly the amount of change given all day.
--
-- Only 'success' tenders. A pending momo prompt is not money, and the
-- user's requirement is explicit: online payments count only once the
-- backend has verified them.

create or replace function payment_method_breakdown(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_branch_id uuid default null
)
returns table (
  method text,
  tender_count bigint,
  amount numeric
)
language sql
stable
as $$
  with tenders as (
    select
      sp.method,
      sp.amount,
      case when sp.method = 'cash' then coalesce(s.change_given, 0) else 0 end as change_back
    from sale_payments sp
    join sales s on s.id = sp.sale_id
    where sp.status = 'success'
      and s.status = 'completed'
      and (p_from is null or sp.created_at >= p_from)
      and (p_to is null or sp.created_at <= p_to)
      and (p_branch_id is null or sp.branch_id = p_branch_id)
  )
  select
    t.method,
    count(*)::bigint,
    sum(t.amount - t.change_back)
  from tenders t
  group by t.method
  order by 3 desc;
$$;

grant execute on function payment_method_breakdown(timestamptz, timestamptz, uuid) to authenticated;

comment on function payment_method_breakdown(timestamptz, timestamptz, uuid) is
  'What was actually taken by each tender type, from the payment ledger rather than the sale''s summary label, with cash net of change given. Verified tenders only. Runs as the caller.';

-- ── 3. What is selling ──────────────────────────────────────────────────
--
-- Ranked by revenue, with quantity and gross profit alongside, because
-- the best-selling product and the most profitable product are often not
-- the same one and a shopkeeper deciding what to restock needs both.
--
-- Returns are netted off. A dress bought and returned twice is not the
-- shop's top line.

create or replace function top_products(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_branch_id uuid default null,
  p_limit int default 5
)
returns table (
  variant_id uuid,
  product_name text,
  sku text,
  quantity_sold numeric,
  revenue numeric,
  gross_profit numeric
)
language sql
stable
as $$
  with scoped as (
    select s.id
    from sales s
    where s.status = 'completed'
      and (p_from is null or s.created_at >= p_from)
      and (p_to is null or s.created_at <= p_to)
      and (p_branch_id is null or s.branch_id = p_branch_id)
  ),
  sold as (
    select
      si.variant_id,
      sum(si.quantity) as qty,
      sum(si.line_total) as revenue,
      sum(si.quantity * si.unit_cost) as cost
    from sale_items si
    where si.sale_id in (select id from scoped)
    group by si.variant_id
  ),
  came_back as (
    select
      si.variant_id,
      sum(ri.quantity) as qty,
      sum(ri.line_total) as revenue,
      sum(ri.quantity * ri.unit_cost) as cost
    from refund_items ri
    join sale_items si on si.id = ri.sale_item_id
    where si.sale_id in (select id from scoped)
    group by si.variant_id
  )
  select
    sold.variant_id,
    p.name,
    v.sku,
    sold.qty - coalesce(came_back.qty, 0),
    sold.revenue - coalesce(came_back.revenue, 0),
    (sold.revenue - coalesce(came_back.revenue, 0))
      - (sold.cost - coalesce(came_back.cost, 0))
  from sold
  left join came_back on came_back.variant_id = sold.variant_id
  join product_variants v on v.id = sold.variant_id
  join products p on p.id = v.product_id
  where sold.qty - coalesce(came_back.qty, 0) > 0
  order by 5 desc, 4 desc
  limit least(greatest(coalesce(p_limit, 5), 1), 50);
$$;

grant execute on function top_products(timestamptz, timestamptz, uuid, int) to authenticated;

comment on function top_products(timestamptz, timestamptz, uuid, int) is
  'Best sellers by revenue with quantity and gross profit, net of returns. Runs as the caller.';

-- ── 4. What is about to run out ─────────────────────────────────────────
--
-- Three states, not one number, because they need different actions:
--   out      — nothing on the shelf; you are turning customers away now
--   critical — at or below half the reorder point; order today
--   low      — at or below the reorder point; put it on the next order
--
-- The threshold is per-variant (reorder_point, added in 0029) and falls
-- back to the business's own low_stock_threshold setting, then to 5. A
-- shop selling both rice by the sack and phone credit cannot have one
-- number mean "low" for both.
--
-- A product that has NEVER been stocked at a branch does not appear
-- there. It has no stock_levels row, because nothing has ever moved. The
-- alternative — listing every product in the catalog as "out" at every
-- branch that has never carried it — would bury the three things that
-- genuinely ran out today under a hundred that were never there. A
-- product sold down to zero DOES appear, because its row exists and
-- reads zero, and that is the case this alert is for.

create or replace function low_stock_report(
  p_branch_id uuid default null,
  p_limit int default 20
)
returns table (
  variant_id uuid,
  branch_id uuid,
  branch_name text,
  product_name text,
  sku text,
  quantity numeric,
  reorder_point numeric,
  severity text
)
language sql
stable
as $$
  with fallback as (
    select coalesce(
      (select (bs.inventory_settings ->> 'low_stock_threshold')::numeric
       from business_settings bs limit 1),
      5
    ) as value
  ),
  levels as (
    select
      sl.variant_id,
      sl.branch_id,
      b.name as branch_name,
      p.name as product_name,
      v.sku,
      sl.quantity,
      coalesce(v.reorder_point, (select value from fallback)) as threshold
    from stock_levels sl
    join product_variants v on v.id = sl.variant_id
    join products p on p.id = v.product_id
    join branches b on b.id = sl.branch_id
    where v.status = 'active'
      and p.status = 'active'
      and (p_branch_id is null or sl.branch_id = p_branch_id)
  )
  select
    l.variant_id, l.branch_id, l.branch_name, l.product_name, l.sku,
    l.quantity, l.threshold,
    case
      when l.quantity <= 0 then 'out'
      when l.quantity <= l.threshold / 2 then 'critical'
      else 'low'
    end
  from levels l
  where l.quantity <= l.threshold
  order by
    case when l.quantity <= 0 then 0 when l.quantity <= l.threshold / 2 then 1 else 2 end,
    l.quantity,
    l.product_name
  limit least(greatest(coalesce(p_limit, 20), 1), 200);
$$;

grant execute on function low_stock_report(uuid, int) to authenticated;

comment on function low_stock_report(uuid, int) is
  'Stock at or below its reorder point, split into out/critical/low so the three get different treatment. Per-variant threshold, falling back to the business setting. Runs as the caller.';

-- ── 5. Who sold what ────────────────────────────────────────────────────
--
-- Attributed to the cashier recorded on the sale, which create_sale sets
-- from the till session — not from anything the browser sent.
--
-- Refunds are shown alongside rather than netted into one figure. A
-- cashier with high takings and high returns is a different situation
-- from one with the same net and no returns, and collapsing them hides
-- exactly the case worth looking at.

create or replace function staff_performance(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_branch_id uuid default null,
  p_limit int default 10
)
returns table (
  cashier_id uuid,
  first_name text,
  last_name text,
  sale_count bigint,
  gross_total numeric,
  refunded_total numeric,
  net_total numeric
)
language sql
stable
as $$
  with scoped as (
    select s.id, s.cashier_id, s.total
    from sales s
    where s.status = 'completed'
      and s.cashier_id is not null
      and (p_from is null or s.created_at >= p_from)
      and (p_to is null or s.created_at <= p_to)
      and (p_branch_id is null or s.branch_id = p_branch_id)
  ),
  sold as (
    select cashier_id, count(*) as sales, sum(total) as amount
    from scoped group by cashier_id
  ),
  -- The refund is charged to the cashier whose sale came back, which is
  -- the question being asked here ("how much of what they sold stuck?"),
  -- not to whoever pressed the refund button.
  returned as (
    select sc.cashier_id, sum(r.total) as amount
    from refunds r
    join scoped sc on sc.id = r.sale_id
    group by sc.cashier_id
  )
  select
    sold.cashier_id,
    pr.first_name,
    pr.last_name,
    sold.sales,
    sold.amount,
    coalesce(returned.amount, 0),
    sold.amount - coalesce(returned.amount, 0)
  from sold
  left join returned on returned.cashier_id = sold.cashier_id
  left join profiles pr on pr.id = sold.cashier_id
  order by 7 desc
  limit least(greatest(coalesce(p_limit, 10), 1), 100);
$$;

grant execute on function staff_performance(timestamptz, timestamptz, uuid, int) to authenticated;

comment on function staff_performance(timestamptz, timestamptz, uuid, int) is
  'Per-cashier takings and returns over a period, attributed from the sale''s recorded cashier. Returns are shown separately, not netted away. Runs as the caller.';

-- ── 6. Branch against branch ────────────────────────────────────────────
--
-- Every active branch appears, including one that sold nothing. A branch
-- that has taken nothing all week is the single most useful row on this
-- table, and a plain GROUP BY over sales would omit it.

create or replace function branch_performance(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  branch_id uuid,
  branch_name text,
  is_main boolean,
  sale_count bigint,
  net_total numeric,
  gross_profit numeric
)
language sql
stable
as $$
  with sold as (
    select
      s.branch_id,
      count(*) as sales,
      sum(s.total) as amount,
      sum(coalesce(li.cost, 0)) as cost
    from sales s
    left join lateral (
      select sum(si.quantity * si.unit_cost) as cost
      from sale_items si where si.sale_id = s.id
    ) li on true
    where s.status = 'completed'
      and (p_from is null or s.created_at >= p_from)
      and (p_to is null or s.created_at <= p_to)
    group by s.branch_id
  ),
  returned as (
    select
      s.branch_id,
      sum(r.total) as amount,
      sum(coalesce(ri.cost, 0)) as cost
    from refunds r
    join sales s on s.id = r.sale_id and s.status = 'completed'
    left join lateral (
      select sum(x.quantity * x.unit_cost) as cost
      from refund_items x where x.refund_id = r.id
    ) ri on true
    where (p_from is null or s.created_at >= p_from)
      and (p_to is null or s.created_at <= p_to)
    group by s.branch_id
  )
  select
    b.id,
    b.name,
    b.is_main,
    coalesce(sold.sales, 0)::bigint,
    coalesce(sold.amount, 0) - coalesce(returned.amount, 0),
    (coalesce(sold.amount, 0) - coalesce(returned.amount, 0))
      - (coalesce(sold.cost, 0) - coalesce(returned.cost, 0))
  from branches b
  left join sold on sold.branch_id = b.id
  left join returned on returned.branch_id = b.id
  where b.status = 'active'
  order by 5 desc, b.is_main desc, b.name;
$$;

grant execute on function branch_performance(timestamptz, timestamptz) to authenticated;

comment on function branch_performance(timestamptz, timestamptz) is
  'Takings and gross profit per branch over a period. Every active branch is listed, including those that sold nothing. Runs as the caller.';