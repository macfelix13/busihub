-- Busihub — 0027: totals for the sales history page
--
-- A list of sales needs a line at the top saying what the period came to.
-- Doing that in the application would mean adding up only the rows on the
-- current page — "today: GH₵240" when today was actually GH₵3,000 across
-- four pages. A wrong total on a money screen is worse than no total, so
-- the sum happens where all the rows are.
--
-- SECURITY INVOKER (the default) on purpose: it reads `sales` as the
-- caller, so the same RLS policy that decides which sales they may list
-- decides which sales they may total. A SECURITY DEFINER function here
-- would have quietly become a way to learn another business's takings.

create or replace function sales_summary(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_status text default null,
  p_branch_id uuid default null
)
returns table (
  sale_count bigint,
  gross_total numeric,
  refunded_total numeric,
  net_total numeric
)
language sql
stable
as $$
  with filtered as (
    select s.id, s.total
    from sales s
    where (p_from is null or s.created_at >= p_from)
      and (p_to is null or s.created_at < p_to)
      and (p_status is null or s.status = p_status)
      and (p_branch_id is null or s.branch_id = p_branch_id)
      -- A cancelled sale was never paid for and a voided one was undone;
      -- neither is takings. They stay visible in the list (that is the
      -- point of a history) but they do not count towards the money.
      and s.status = 'completed'
  ),
  refunded as (
    select coalesce(sum(r.total), 0) as amount
    from refunds r
    where r.sale_id in (select id from filtered)
  )
  select
    (select count(*) from filtered),
    (select coalesce(sum(total), 0) from filtered),
    (select amount from refunded),
    (select coalesce(sum(total), 0) from filtered) - (select amount from refunded);
$$;

grant execute on function sales_summary(timestamptz, timestamptz, text, uuid) to authenticated;

comment on function sales_summary(timestamptz, timestamptz, text, uuid) is
  'Takings for a filtered period: how many completed sales, what they came to, what was returned, and the net. Runs as the caller so RLS decides which sales are counted. Voided and cancelled sales are excluded from the money but remain in the list.';
