-- Busihub — 0056: split sales reporting by product vs. service.
--
-- Requested directly: a business selling both stocked goods and labour
-- (0040) wants to see how the two sides are doing SEPARATELY — "Products
-- report" and "Services report" alongside the existing combined "Sales
-- report", not instead of it.
--
-- WHY THIS IS A REAL QUERY REWRITE, NOT JUST AN ADDED FILTER
--
-- The till lets one checkout mix a product line and a service line (a
-- retail shampoo plus a haircut, rung up together — 0040's whole point).
-- top_products() already works line-by-line, so it took a plain filter.
-- sales_summary() and sales_trend() do not: they total a SALE's `total`
-- column, which is one number for the whole cart. There is no way to say
-- "GHS 30 of this GHS 80 sale was the product" from that column alone —
-- the answer has to be rebuilt from sale_items/refund_items themselves,
-- joined through product_variants to products.type.
--
-- WHAT IS DELIBERATELY UNCHANGED WHEN p_type IS NULL
--
-- Every existing caller (the combined Sales report, the dashboard,
-- profit_and_loss(), and tests/security/reports.sql's own line-by-line
-- cross-check against profit_and_loss()) calls these functions without a
-- type argument. For that case, each function below runs the EXACT same
-- query it always has — copied verbatim from 0029/0030 — so none of those
-- figures move by so much as a cedi pesewa. Only supplying p_type takes
-- the new, line-level path.
--
-- WHAT sale_count MEANS ONCE SCOPED BY TYPE
--
-- "Sales that included at least one line of this type." A mixed cart
-- counts toward BOTH a Products report and a Services report run for the
-- same period — that is expected, not a reconciliation bug, and both new
-- report pages say so.
--
-- WHAT IS DELIBERATELY NOT SPLIT HERE (raised with, and agreed by, the
-- user before writing this)
--
--   * payment_method_breakdown() — a tender is recorded once per whole
--     sale (sale_payments), with no line-level record of which items it
--     paid for. There is no honest way to say how much of a mixed sale's
--     cash payment was "for the product" versus "for the service" without
--     an invented allocation rule, so this section stays only on the
--     combined Sales report, where the question is unambiguous.
--   * staff_performance() — same shape of problem: it attributes a
--     sale's FULL total to whoever cashiered it, not to a line. Also left
--     on the combined Sales report only.
--   * service_provider_performance() is NOT touched by this migration at
--     all — it already answers "service revenue by whoever rendered it"
--     at the line level (0041/0045), with no mixed-cart ambiguity, so the
--     new Services report page reuses it exactly as it already is.
--
-- DROPPED, not just redefined with an added parameter — same trap 0026
-- and 0040 already documented: an added trailing argument makes the
-- default-parameter overload ambiguous for a caller (Supabase's RPC calls
-- go by argument NAME) that only ever supplies the original arguments.
-- Dropping first means there is exactly one version of each function
-- again, and every existing caller — positional or named — simply gets
-- p_type = null, the unchanged behaviour, without asking for it.

-- ── 1. top_products(): a plain filter — it was already line-level ───────

drop function if exists top_products(timestamptz, timestamptz, uuid, int);

create or replace function top_products(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_branch_id uuid default null,
  p_limit int default 5,
  p_type text default null -- 'product' | 'service' | null (both, unchanged)
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
    and (p_type is null or p.type = p_type)
  order by 5 desc, 4 desc
  limit least(greatest(coalesce(p_limit, 5), 1), 50);
$$;

grant execute on function top_products(timestamptz, timestamptz, uuid, int, text) to authenticated;

comment on function top_products(timestamptz, timestamptz, uuid, int, text) is
  'Best sellers by revenue with quantity and gross profit, net of returns. p_type filters to ''product'' or ''service''; null (the default, and every caller before 0056) means both. Runs as the caller.';

-- ── 2. sales_summary(): unchanged when p_type is null, rebuilt from line
-- items when it is not ────────────────────────────────────────────────────

drop function if exists sales_summary(timestamptz, timestamptz, text, uuid);

create or replace function sales_summary(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_status text default null,
  p_branch_id uuid default null,
  p_type text default null -- 'product' | 'service' | null (both, unchanged)
)
returns table (
  sale_count bigint,
  gross_total numeric,
  refunded_total numeric,
  net_total numeric,
  cost_total numeric,
  gross_profit numeric,
  items_sold numeric,
  any_cost_estimated boolean
)
language plpgsql
stable
as $$
begin
  if p_type is not null and p_type not in ('product', 'service') then
    raise exception 'Unknown type: %', p_type using errcode = '22023';
  end if;

  if p_type is null then
    -- Byte-identical to the query 0029 shipped — every caller that has
    -- never heard of p_type (profit_and_loss(), the combined Sales
    -- report, the dashboard) keeps getting exactly this.
    return query
    with filtered as (
      select s.id, s.total
      from sales s
      where (p_from is null or s.created_at >= p_from)
        and (p_to is null or s.created_at < p_to)
        and (p_status is null or s.status = p_status)
        and (p_branch_id is null or s.branch_id = p_branch_id)
        and s.status = 'completed'
    ),
    lines as (
      select
        coalesce(sum(si.quantity * si.unit_cost), 0) as cost,
        coalesce(sum(si.quantity), 0) as units,
        bool_or(si.cost_is_estimated) as estimated
      from sale_items si
      where si.sale_id in (select id from filtered)
    ),
    returned as (
      select
        coalesce(sum(r.total), 0) as amount,
        coalesce(sum(ri.quantity * ri.unit_cost), 0) as cost
      from refunds r
      join refund_items ri on ri.refund_id = r.id
      where r.sale_id in (select id from filtered)
    )
    select
      (select count(*) from filtered),
      (select coalesce(sum(total), 0) from filtered),
      (select amount from returned),
      (select coalesce(sum(total), 0) from filtered) - (select amount from returned),
      (select cost from lines) - (select cost from returned),
      ((select coalesce(sum(total), 0) from filtered) - (select amount from returned))
        - ((select cost from lines) - (select cost from returned)),
      (select units from lines),
      (select coalesce(estimated, false) from lines);
    return;
  end if;

  -- p_type scoped: rebuilt from sale_items/refund_items joined through
  -- product_variants to products.type, since a sale's own `total` can
  -- cover more than one type of line (see this migration's own header).
  -- sale_count = sales that had at least one line of this type — can
  -- double-count a mixed sale across a Products report and a Services
  -- report for the same period, by design.
  return query
  with filtered as (
    select s.id
    from sales s
    where (p_from is null or s.created_at >= p_from)
      and (p_to is null or s.created_at < p_to)
      and (p_status is null or s.status = p_status)
      and (p_branch_id is null or s.branch_id = p_branch_id)
      and s.status = 'completed'
  ),
  scoped_lines as (
    select si.sale_id, si.quantity, si.unit_cost, si.line_total, si.cost_is_estimated
    from sale_items si
    join product_variants v on v.id = si.variant_id
    join products p on p.id = v.product_id
    where si.sale_id in (select id from filtered)
      and p.type = p_type
  ),
  scoped_returns as (
    select ri.quantity, ri.unit_cost, ri.line_total
    from refund_items ri
    join sale_items si on si.id = ri.sale_item_id
    join product_variants v on v.id = ri.variant_id
    join products p on p.id = v.product_id
    where si.sale_id in (select id from filtered)
      and p.type = p_type
  )
  select
    (select count(distinct sale_id) from scoped_lines),
    (select coalesce(sum(line_total), 0) from scoped_lines),
    (select coalesce(sum(line_total), 0) from scoped_returns),
    (select coalesce(sum(line_total), 0) from scoped_lines) - (select coalesce(sum(line_total), 0) from scoped_returns),
    (select coalesce(sum(quantity * unit_cost), 0) from scoped_lines) - (select coalesce(sum(quantity * unit_cost), 0) from scoped_returns),
    ((select coalesce(sum(line_total), 0) from scoped_lines) - (select coalesce(sum(line_total), 0) from scoped_returns))
      - ((select coalesce(sum(quantity * unit_cost), 0) from scoped_lines) - (select coalesce(sum(quantity * unit_cost), 0) from scoped_returns)),
    (select coalesce(sum(quantity), 0) from scoped_lines),
    (select coalesce(bool_or(cost_is_estimated), false) from scoped_lines);
end;
$$;

grant execute on function sales_summary(timestamptz, timestamptz, text, uuid, text) to authenticated;

comment on function sales_summary(timestamptz, timestamptz, text, uuid, text) is
  'Takings for a filtered period. p_type filters to ''product'' or ''service'' lines, rebuilt from sale_items/refund_items since one sale can mix both (0040); null (the default, and every caller before 0056) reproduces the original whole-sale totals exactly. Runs as the caller, so RLS scopes it.';

-- ── 3. sales_trend(): same treatment, bucketed ───────────────────────────

drop function if exists sales_trend(timestamptz, timestamptz, uuid, text, text);

create or replace function sales_trend(
  p_from timestamptz,
  p_to timestamptz default null,
  p_branch_id uuid default null,
  p_bucket text default 'day',
  p_timezone text default 'Africa/Accra',
  p_type text default null -- 'product' | 'service' | null (both, unchanged)
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
  if p_type is not null and p_type not in ('product', 'service') then
    raise exception 'Unknown type: %', p_type using errcode = '22023';
  end if;
  select name into v_tz from pg_timezone_names where name = p_timezone;
  v_tz := coalesce(v_tz, 'Africa/Accra');
  v_step := ('1 ' || p_bucket)::interval;

  if p_type is null then
    -- Byte-identical to the query 0030 shipped.
    return query
    with buckets as (
      select generate_series(
        date_trunc(p_bucket, p_from at time zone v_tz),
        date_trunc(p_bucket, v_to at time zone v_tz),
        v_step
      ) as local_start
    ),
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
    return;
  end if;

  -- p_type scoped: bucket sums come from sale_items/refund_items joined
  -- through product_variants to products.type, not from sales.total —
  -- see this migration's own header for why. sale_count per bucket counts
  -- distinct sales with at least one line of this type in that bucket.
  return query
  with buckets as (
    select generate_series(
      date_trunc(p_bucket, p_from at time zone v_tz),
      date_trunc(p_bucket, v_to at time zone v_tz),
      v_step
    ) as local_start
  ),
  sold as (
    select
      date_trunc(p_bucket, s.created_at at time zone v_tz) as local_start,
      count(distinct s.id) as sales,
      sum(si.line_total) as amount,
      sum(si.quantity * si.unit_cost) as cost
    from sales s
    join sale_items si on si.sale_id = s.id
    join product_variants v on v.id = si.variant_id
    join products p on p.id = v.product_id
    where s.status = 'completed'
      and s.created_at >= p_from
      and s.created_at <= v_to
      and (p_branch_id is null or s.branch_id = p_branch_id)
      and p.type = p_type
    group by 1
  ),
  returned as (
    select
      date_trunc(p_bucket, r.created_at at time zone v_tz) as local_start,
      sum(ri.line_total) as amount,
      sum(ri.quantity * ri.unit_cost) as cost
    from refunds r
    join refund_items ri on ri.refund_id = r.id
    join product_variants v on v.id = ri.variant_id
    join products p on p.id = v.product_id
    where r.created_at >= p_from
      and r.created_at <= v_to
      and (p_branch_id is null or exists (
        select 1 from sales s where s.id = r.sale_id and s.branch_id = p_branch_id
      ))
      and p.type = p_type
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

grant execute on function sales_trend(timestamptz, timestamptz, uuid, text, text, text) to authenticated;

comment on function sales_trend(timestamptz, timestamptz, uuid, text, text, text) is
  'Completed sales and gross profit per hour/day/week/month, gap-filled, bucketed in the shop''s own timezone. p_type filters to ''product'' or ''service'' lines, rebuilt from sale_items/refund_items since one sale can mix both (0040); null (the default, and every caller before 0056) reproduces the original whole-sale totals exactly. Runs as the caller.';