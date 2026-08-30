-- Busihub — 0023: settlement is tenant-scoped, and history joins the ledger
--
-- Two corrections to 0022, both found while wiring the webhook to it.
--
-- ONE — a cross-tenant hole. settle_sale_payment() took a payment id and
-- nothing else. The webhook endpoint is per business (each shop pastes
-- its own URL into its own Paystack dashboard), and the signature is
-- checked against that shop's secret — but nothing tied the PAYMENT to
-- the shop whose signature had just been verified. A business could sign
-- a charge.success for a reference belonging to someone else's sale and
-- settle it. The route can check that, and does; it should not be the
-- only thing that checks it.
--
-- TWO — every sale rung up before 0022 has no tender rows, because the
-- ledger did not exist. Nothing breaks today, but "how was this paid
-- for?" would silently skip them forever, and the reconciliation the
-- payment tests assert would not hold across the whole table. History is
-- backfilled from what those sales already recorded.

-- ── settlement, tied to the business it belongs to ──────────────────────

drop function if exists settle_sale_payment(uuid, text, text, text);

create or replace function settle_sale_payment(
  p_business_id uuid,
  p_payment_id uuid,
  p_status text,               -- 'success' | 'failed'
  p_provider_charge_id text,
  p_failure_reason text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment sale_payments%rowtype;
  v_sale    sales%rowtype;
  v_paid    numeric(14, 2);
begin
  if p_status not in ('success', 'failed') then
    raise exception 'A payment settles as success or failed' using errcode = '22023';
  end if;

  select * into v_payment from sale_payments where id = p_payment_id for update;
  if v_payment.id is null then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;

  -- The caller has proved it is this business (a webhook signature made
  -- with that shop's own secret key). It has not proved anything about a
  -- payment belonging to a different one.
  if p_business_id is null or v_payment.business_id <> p_business_id then
    raise exception 'That payment belongs to another business' using errcode = '42501';
  end if;

  -- A webhook retry, or the till's verify call racing the webhook. Both
  -- are routine, and neither is an error — report what already happened.
  if v_payment.status <> 'pending' then
    return v_payment.status;
  end if;

  update sale_payments
  set status = p_status,
      provider_charge_id = coalesce(p_provider_charge_id, provider_charge_id),
      failure_reason = case when p_status = 'failed' then p_failure_reason else null end,
      settled_at = now()
  where id = p_payment_id;

  if p_status = 'failed' then
    return 'failed';
  end if;

  select * into v_sale from sales where id = v_payment.sale_id;

  -- finalize_sale recomputes this itself and refuses a sale that is
  -- short, so this is only deciding whether it is worth asking. Cash is
  -- counted at what was handed over less the change that went back.
  select coalesce(sum(amount), 0) - v_sale.change_given into v_paid
  from sale_payments
  where sale_id = v_payment.sale_id and status = 'success';

  if v_paid >= v_sale.total and v_sale.status = 'awaiting_payment' then
    perform finalize_sale(v_sale.id);
    return 'completed';
  end if;

  return 'success';
end;
$$;

revoke all on function settle_sale_payment(uuid, uuid, text, text, text) from public, authenticated, anon;
grant execute on function settle_sale_payment(uuid, uuid, text, text, text) to service_role;

comment on function settle_sale_payment(uuid, uuid, text, text, text) is
  'Records the outcome of a mobile money charge and completes the sale once its payments cover the total. Scoped to the business the caller proved it is, so a signed webhook cannot settle another shop''s payment. Idempotent: a repeated webhook for a payment that is already settled returns the settled status and changes nothing. service_role only.';

-- ── history joins the ledger ────────────────────────────────────────────
--
-- One tender per sale that predates sale_payments, derived from what the
-- sale itself already recorded. Cash uses amount_tendered — what was
-- actually handed over — falling back to the total for the older rows
-- where it was not captured. Nothing is invented: a sale that was paid in
-- cash gets a cash tender for the amount that sale says it took.
--
-- Guarded by NOT EXISTS rather than a date, so re-running this migration
-- on a database that already has it is a no-op.

insert into sale_payments (
  business_id, sale_id, branch_id, method, amount, status, settled_at, created_by, created_at
)
select
  s.business_id,
  s.id,
  s.branch_id,
  case when s.payment_method = 'credit' then 'credit' else 'cash' end,
  case
    when s.payment_method = 'credit' then s.total
    when s.amount_tendered > 0 then s.amount_tendered
    else s.total
  end,
  'success',
  s.created_at,
  s.created_by,
  s.created_at
from sales s
where s.status in ('completed', 'voided')
  and s.payment_method in ('cash', 'credit')
  and not exists (select 1 from sale_payments p where p.sale_id = s.id)
  -- A zero-total sale has nothing to tender, and the amount column
  -- requires a positive value.
  and (case when s.payment_method = 'credit' then s.total
            when s.amount_tendered > 0 then s.amount_tendered
            else s.total end) > 0;

do $$
declare v_missing int;
begin
  select count(*) into v_missing
  from sales s
  where s.status in ('completed', 'voided')
    and s.total > 0
    and not exists (select 1 from sale_payments p where p.sale_id = s.id);

  if v_missing > 0 then
    raise warning 'Backfill left % completed/voided sale(s) without a tender row — inspect before relying on payment reports.', v_missing;
  else
    raise notice 'Backfill complete: every completed or voided sale has at least one tender.';
  end if;
end $$;
