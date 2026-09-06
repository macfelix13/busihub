-- Busihub — 0038: fix receipt/refund numbering broken by 0037.
--
-- create_sale() and create_refund() are invoker-rights functions —
-- deliberately so, per their own comments, so that their INSERTs stay
-- subject to normal RLS. Before generating a receipt/refund number they
-- run:
--
--   select coalesce(max(...), 0) + 1 from sales/refunds where business_id = ...
--
-- under an advisory lock, so two tills can't claim the same number. That
-- select runs as the CALLING cashier, so it is itself subject to
-- sales_select/refunds_select — before 0037, those granted any
-- sales.process holder full visibility of every sale/refund in the
-- business, so the max-based sequence always saw the true high-water
-- mark regardless of who was asking.
--
-- 0037 narrowed sales_select/refunds_select so a sales.process holder
-- (without reports.view — the default Cashier role) only sees their OWN
-- cashier_id's rows. That is exactly the fix a cashier's own sales
-- list/history needed, but it has a side effect nobody wants: it also
-- narrows what the numbering query can see. A second cashier's next sale
-- then computes a receipt number some *other* cashier already used, and
-- the insert fails outright instead of getting a correct number.
--
-- This is not a theoretical risk — running the full test suite after
-- 0037 landed reproduced it immediately:
--   tests/security/refunds.sql:
--     ERROR: duplicate key value violates unique constraint
--     "sales_business_id_receipt_number_key"
-- as soon as a second, reports.view-less cashier fixture rang up a sale
-- after another cashier already had. Any real business with two or more
-- active cashiers on a shift would hit this in practice, not just in a
-- test.
--
-- The fix is two narrow SECURITY DEFINER helpers, in the same spirit as
-- set_profile_pin/verify_profile_pin (0018): each hands back nothing but
-- a bare next-number string, computed across ALL sales/refunds for the
-- business regardless of the caller's own RLS-visible subset. That is a
-- deliberate, minimal, well-understood bypass of RLS for one harmless
-- read — not a reopening of sales_select/refunds_select, which stay
-- exactly as narrow as 0037 left them for every other purpose (a
-- cashier's own list/history, direct queries from the browser client,
-- and every reporting RPC still see only what 0037 intended).
--
-- Both helpers assume the caller already holds the relevant advisory
-- lock (pg_advisory_xact_lock on 'receipt:<business_id>' /
-- 'refund:<business_id>') — they do no locking of their own, since they
-- are only ever called from inside create_sale()/create_refund(), which
-- already take it immediately before.
--
-- create_sale() and create_refund() are then re-declared here to call the
-- helpers instead of running the max() query themselves. Both are
-- reproduced in full from their CURRENT live definitions — create_sale's
-- as last redefined by 0029 (which added the p_payments parameter and the
-- cost-of-goods/multi-tender rewrite; 0022/0024/0025 versions are stale),
-- create_refund's as last redefined by 0034 (which added the
-- refund_created notification insert; 0021/0029 versions are stale) — not
-- from their original 0020/0021 versions, since `create or replace`
-- replaces by exact signature and Postgres would otherwise have created
-- confusing duplicate overloads instead of really replacing anything.
-- Only the numbering block changes in each; everything else, comment for
-- comment, is exactly what is live today.

create or replace function next_receipt_number(p_business_id uuid)
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select 'R-' || lpad(
    (coalesce(max((substring(receipt_number from '^R-([0-9]+)$'))::int), 0) + 1)::text,
    6, '0'
  )
  from sales
  where business_id = p_business_id and receipt_number ~ '^R-[0-9]+$';
$$;

comment on function next_receipt_number(uuid) is
  'The next R-NNNNNN receipt number for a business, computed across every sale regardless of the caller''s own RLS-visible subset — see 0038 for why sales_select being narrowed to a cashier''s own rows would otherwise make two cashiers collide on the same number. Callers must already hold pg_advisory_xact_lock(hashtextextended(''receipt:''||business_id, 0)) before calling this; it does no locking of its own. Returns a value only, never a row — no sales data is exposed through it.';

grant execute on function next_receipt_number(uuid) to authenticated;

create or replace function next_refund_number(p_business_id uuid)
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select 'RF-' || lpad(
    (coalesce(max((substring(refund_number from '^RF-([0-9]+)$'))::int), 0) + 1)::text,
    6, '0'
  )
  from refunds
  where business_id = p_business_id and refund_number ~ '^RF-[0-9]+$';
$$;

comment on function next_refund_number(uuid) is
  'The next RF-NNNNNN refund number for a business, computed across every refund regardless of the caller''s own RLS-visible subset — see next_receipt_number() and 0038 for why. Callers must already hold pg_advisory_xact_lock(hashtextextended(''refund:''||business_id, 0)) before calling this. Returns a value only, never a row.';

grant execute on function next_refund_number(uuid) to authenticated;

-- ── create_sale(): current (0029) definition, numbering block only ──────

create or replace function create_sale(
  p_branch_id uuid,
  p_cashier_id uuid,
  p_customer_id uuid,
  p_payment_method text,
  p_amount_tendered numeric,
  p_items jsonb,                  -- [{variant_id, quantity}]
  p_payments jsonb default null   -- [{method, amount, momo_number, momo_network}]
)
returns uuid
language plpgsql
as $$
declare
  v_business_id   uuid;
  v_sale_id       uuid;
  v_item          jsonb;
  v_pay           jsonb;
  v_variant       record;
  v_qty           numeric(14, 3);
  v_reference     text;
  v_settings      jsonb;
  v_vat_enabled   boolean;
  v_inclusive     boolean;
  v_vat           numeric;
  v_levies        numeric;
  v_gross         numeric(14, 2);
  v_base          numeric;
  v_line_tax      numeric(14, 2);
  v_line_subtotal numeric(14, 2);
  v_subtotal      numeric(14, 2) := 0;
  v_tax_total     numeric(14, 2) := 0;
  v_total         numeric(14, 2) := 0;
  v_change        numeric(14, 2) := 0;
  v_lines         jsonb := '[]'::jsonb;
  v_tenders       jsonb;
  v_method        text;
  v_amount        numeric(14, 2);
  v_cash          numeric(14, 2) := 0;
  v_momo          numeric(14, 2) := 0;
  v_credit        numeric(14, 2) := 0;
  v_methods       text[] := '{}';
  v_credit_is_total boolean := false;
  v_momo_is_remainder boolean := false;
  v_summary       text;
  v_status        text;
  v_payment_id    uuid;
begin
  if p_items is null or jsonb_array_length(p_items) < 1 then
    raise exception 'A sale needs at least one item' using errcode = 'P0001';
  end if;

  -- Backwards compatible: a caller that passes no payments (everything
  -- written before this migration, and every existing test) gets exactly
  -- the old single-tender behaviour, derived from the two arguments it
  -- did pass.
  if p_payments is null then
    if p_payment_method not in ('cash', 'credit') then
      raise exception 'Unknown payment method' using errcode = '22023';
    end if;
    -- Note what the old form does NOT carry: an amount for a credit sale.
    -- It passed amount_tendered = 0 there, meaning "the whole total",
    -- which is not known until the lines are priced. The amount is left
    -- out and filled in below rather than validated as a zero payment.
    v_tenders := case
      when p_payment_method = 'credit'
        then jsonb_build_array(jsonb_build_object('method', 'credit'))
      else jsonb_build_array(jsonb_build_object(
        'method', 'cash', 'amount', coalesce(p_amount_tendered, 0)))
    end;
  else
    v_tenders := p_payments;
  end if;

  if jsonb_array_length(v_tenders) < 1 then
    raise exception 'A sale needs at least one payment' using errcode = 'P0001';
  end if;

  select business_id into v_business_id from branches where id = p_branch_id;
  if v_business_id is null then
    raise exception 'Invalid branch_id: branch not found' using errcode = 'P0002';
  end if;

  if p_customer_id is not null then
    if not exists (select 1 from customers where id = p_customer_id and business_id = v_business_id) then
      raise exception 'Invalid customer_id: customer not found' using errcode = 'P0002';
    end if;
  end if;

  if p_cashier_id is not null then
    if not exists (
      select 1 from profiles
      where id = p_cashier_id and business_id = v_business_id and status = 'active'
    ) then
      raise exception 'Invalid cashier' using errcode = 'P0002';
    end if;
  end if;

  -- ── the tenders, before anything is written ───────────────────────────
  for v_pay in select * from jsonb_array_elements(v_tenders)
  loop
    v_method := v_pay ->> 'method';
    if v_method not in ('cash', 'momo', 'credit') then
      raise exception 'Unknown payment method' using errcode = '22023';
    end if;
    if v_method = any (v_methods) then
      raise exception 'The same payment method was given twice' using errcode = 'P0001';
    end if;
    v_methods := v_methods || v_method;

    if v_method = 'cash' then
      -- Cash is the one tender that may be short at this point: it is
      -- allowed to be zero here and checked against the total below,
      -- because the old two-argument form passes the tendered amount.
      v_cash := coalesce((v_pay ->> 'amount')::numeric, 0);
      if v_cash < 0 then
        raise exception 'Cash tendered cannot be negative' using errcode = 'P0001';
      end if;
    elsif v_method = 'credit' and coalesce(jsonb_typeof(v_pay -> 'amount'), 'null') = 'null' then
      -- "The whole total", filled in once the lines are priced.
      v_credit_is_total := true;

    elsif v_method = 'momo' and coalesce(jsonb_typeof(v_pay -> 'amount'), 'null') = 'null' then
      -- "Whatever the cash did not cover", filled in once the lines are
      -- priced. This is how the till asks for a mobile money charge: it
      -- never names the amount, because it does not know the authoritative
      -- total and must not be able to prompt a customer's phone for a
      -- figure of its own choosing.
      v_momo_is_remainder := true;
      if coalesce(v_pay ->> 'momo_number', '') = '' then
        raise exception 'A mobile money payment needs a phone number' using errcode = 'P0001';
      end if;
      if coalesce(v_pay ->> 'momo_network', '') not in ('mtn', 'vod', 'atl') then
        raise exception 'Choose the customer''s mobile money network' using errcode = 'P0001';
      end if;
    else
      v_amount := (v_pay ->> 'amount')::numeric;
      if v_amount is null or v_amount <= 0 then
        raise exception 'Every payment needs an amount greater than zero' using errcode = 'P0001';
      end if;
      if v_method = 'momo' then
        v_momo := v_amount;
        if coalesce(v_pay ->> 'momo_number', '') = '' then
          raise exception 'A mobile money payment needs a phone number' using errcode = 'P0001';
        end if;
        if coalesce(v_pay ->> 'momo_network', '') not in ('mtn', 'vod', 'atl') then
          raise exception 'Choose the customer''s mobile money network' using errcode = 'P0001';
        end if;
      else
        v_credit := v_amount;
      end if;
    end if;
  end loop;

  -- On account is not a tender you can top up at the counter. Part-paying
  -- an account sale is a payment AGAINST the account (0017), recorded
  -- separately — mixing them here would mean re-checking a credit limit
  -- long after the customer has left.
  if (v_credit > 0 or v_credit_is_total) and array_length(v_methods, 1) > 1 then
    raise exception 'An account sale cannot be part-paid at the till' using errcode = 'P0001';
  end if;

  if (v_credit > 0 or v_credit_is_total) and p_customer_id is null then
    raise exception 'A credit sale needs a customer' using errcode = 'P0001';
  end if;

  -- 0020 wrote the account entry as the caller, so the account ledger's
  -- own insert policy demanded customers.view. finalize_sale writes it as
  -- its owner now, which would quietly have dropped that requirement, so
  -- it is asserted here instead of being lost in the refactor.
  if (v_credit > 0 or v_credit_is_total)
     and not (app_has_permission(v_business_id, 'customers.view') or app_is_super_admin()) then
    raise exception 'Missing permission: customers.view' using errcode = '42501';
  end if;

  select tax_settings into v_settings from business_settings where business_id = v_business_id;
  v_vat_enabled := coalesce((v_settings ->> 'vat_enabled')::boolean, false);
  v_inclusive   := coalesce((v_settings ->> 'vat_inclusive')::boolean, true);
  v_vat         := coalesce((v_settings ->> 'vat_rate')::numeric, 0);
  v_levies      := coalesce((v_settings ->> 'nhil_levy_rate')::numeric, 0)
                 + coalesce((v_settings ->> 'getfund_levy_rate')::numeric, 0)
                 + coalesce((v_settings ->> 'covid_levy_rate')::numeric, 0);

  -- FIRST PASS: price every line and total the sale, writing nothing.
  -- (Unchanged from 0020 — the sale row is still inserted once, already
  -- correct, because `sales` grants UPDATE on nothing but status.)
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every line needs a quantity greater than zero' using errcode = 'P0001';
    end if;

    select v.id, v.sku, v.selling_price, v.cost_price, v.status, p.name, p.tax_category
    into v_variant
    from product_variants v
    join products p on p.id = v.product_id
    where v.id = (v_item ->> 'variant_id')::uuid
      and v.business_id = v_business_id;

    if v_variant.id is null then
      raise exception 'Invalid variant_id: product not found' using errcode = 'P0002';
    end if;
    if v_variant.status <> 'active' then
      raise exception 'That product is archived and cannot be sold' using errcode = 'P0001';
    end if;

    v_gross := round(v_variant.selling_price * v_qty, 2);

    if not v_vat_enabled or v_variant.tax_category in ('zero_rated', 'exempt') then
      v_line_tax := 0;
      v_line_subtotal := v_gross;
    elsif v_inclusive then
      v_base := v_gross / ((1 + v_levies) * (1 + v_vat));
      v_line_subtotal := round(v_base, 2);
      v_line_tax := v_gross - v_line_subtotal;
    else
      v_line_subtotal := v_gross;
      v_line_tax := round((v_gross * v_levies) + ((v_gross * (1 + v_levies)) * v_vat), 2);
      v_gross := v_line_subtotal + v_line_tax;
    end if;

    v_lines := v_lines || jsonb_build_object(
      'variant_id', v_variant.id,
      'description', v_variant.name,
      'sku', v_variant.sku,
      'quantity', v_qty,
      'unit_price', v_variant.selling_price,
      -- What this unit COST us, captured now. Cost prices change; a
      -- profit figure derived from today's cost applied to last month's
      -- sale is not a rounder number, it is a wrong one.
      'unit_cost', coalesce(v_variant.cost_price, 0),
      'tax_category', v_variant.tax_category,
      'line_subtotal', v_line_subtotal,
      'line_tax', v_line_tax,
      'line_total', v_gross
    );

    v_subtotal  := v_subtotal + v_line_subtotal;
    v_tax_total := v_tax_total + v_line_tax;
    v_total     := v_total + v_gross;
  end loop;

  -- An account sale is for the whole total by definition; now that the
  -- lines are priced, we know what that is.
  if v_credit_is_total then
    v_credit := v_total;
  end if;

  if v_momo_is_remainder then
    v_momo := v_total - v_cash;
    if v_momo <= 0 then
      raise exception 'The cash already covers this sale — there is nothing to charge to mobile money'
        using errcode = 'P0001';
    end if;
  end if;

  -- ── does the money add up? ────────────────────────────────────────────
  --
  -- Everything that is not cash must be exact: you cannot overcharge a
  -- momo prompt and hand back the difference, and an account sale is the
  -- total by definition. Cash is the only tender that may exceed, and the
  -- excess is the change in the drawer.
  if v_momo + v_credit > v_total then
    raise exception 'The payments come to more than the sale' using errcode = 'P0001';
  end if;

  if v_credit > 0 and v_credit <> v_total then
    raise exception 'An account sale must be for the whole amount' using errcode = 'P0001';
  end if;

  if v_cash + v_momo + v_credit < v_total then
    raise exception 'Not enough tendered for a total of %', v_total using errcode = 'P0001';
  end if;

  if v_cash > 0 then
    v_change := v_cash - (v_total - v_momo - v_credit);
  end if;

  -- A momo charge has not happened yet — it is a prompt on a phone that
  -- the customer has three minutes to approve.
  v_status := case when v_momo > 0 then 'awaiting_payment' else 'completed' end;

  v_summary := case
    when array_length(v_methods, 1) > 1 then 'split'
    when v_credit > 0 then 'credit'
    when v_momo > 0 then 'momo'
    else 'cash'
  end;

  -- Receipt number, serialised per business so two tills cannot both
  -- claim R-000042. The actual max-lookup is delegated to
  -- next_receipt_number() (0038) so it sees every sale in the business
  -- regardless of the caller's own RLS-scoped view of `sales` (0037
  -- narrowed sales_select to a cashier's own rows).
  perform pg_advisory_xact_lock(hashtextextended('receipt:' || v_business_id::text, 0));

  v_reference := next_receipt_number(v_business_id);

  insert into sales (
    business_id, branch_id, receipt_number, customer_id, status, payment_method,
    subtotal, tax_total, total, amount_tendered, change_given, cashier_id, created_by
  )
  values (
    v_business_id, p_branch_id, v_reference, p_customer_id,
    -- Inserted as awaiting_payment and moved to completed below by
    -- finalize_sale, so a cash sale and a momo sale reach 'completed'
    -- through exactly the same code.
    'awaiting_payment', v_summary,
    v_subtotal, v_tax_total, v_total, v_cash, v_change,
    p_cashier_id, auth.uid()
  )
  returning id into v_sale_id;

  -- SECOND PASS: the lines, and the stock they take out. The stock leaves
  -- now even if the money has not arrived — see the header.
  for v_item in select * from jsonb_array_elements(v_lines)
  loop
    insert into sale_items (
      sale_id, business_id, variant_id, description, sku, quantity,
      unit_price, unit_cost, cost_is_estimated, tax_category,
      line_subtotal, line_tax, line_total
    )
    values (
      v_sale_id, v_business_id, (v_item ->> 'variant_id')::uuid,
      v_item ->> 'description', v_item ->> 'sku', (v_item ->> 'quantity')::numeric,
      (v_item ->> 'unit_price')::numeric, (v_item ->> 'unit_cost')::numeric,
      false, -- recorded at the moment of sale, not guessed afterwards
      v_item ->> 'tax_category',
      (v_item ->> 'line_subtotal')::numeric, (v_item ->> 'line_tax')::numeric,
      (v_item ->> 'line_total')::numeric
    );

    insert into inventory_movements (
      business_id, branch_id, variant_id, quantity_delta, reason,
      reference_type, reference_id, note
    )
    values (
      '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
      p_branch_id, (v_item ->> 'variant_id')::uuid, -(v_item ->> 'quantity')::numeric, 'sale',
      'sale', v_sale_id, 'Sold on ' || v_reference
    );
  end loop;

  -- THIRD PASS: the tenders themselves.
  for v_pay in select * from jsonb_array_elements(v_tenders)
  loop
    v_method := v_pay ->> 'method';
    v_amount := case
      when v_method = 'cash' then v_cash
      when v_method = 'credit' then v_credit
      when v_method = 'momo' then v_momo
      else (v_pay ->> 'amount')::numeric
    end;

    -- The old two-argument form passes amount_tendered = 0 for a credit
    -- sale, and a cash sale of a zero-priced item tenders nothing. There
    -- is no tender row to write in either case.
    continue when v_amount is null or v_amount <= 0;

    -- The id is generated here rather than defaulted, so that the
    -- reference Paystack will quote back to us can be the row's own id
    -- and still be written by the INSERT. It cannot be an UPDATE
    -- afterwards: `sale_payments` grants UPDATE to nobody, which is what
    -- stops a cashier marking their own momo prompt as received.
    v_payment_id := gen_random_uuid();

    insert into sale_payments (
      id, business_id, sale_id, branch_id, method, amount, status,
      provider, provider_reference, momo_number, momo_network, settled_at, created_by
    )
    values (
      v_payment_id, v_business_id, v_sale_id, p_branch_id, v_method, v_amount,
      case when v_method = 'momo' then 'pending' else 'success' end,
      case when v_method = 'momo' then 'paystack' else null end,
      case when v_method = 'momo' then v_payment_id::text else null end,
      v_pay ->> 'momo_number', v_pay ->> 'momo_network',
      case when v_method = 'momo' then null else now() end,
      auth.uid()
    );
  end loop;

  -- Nothing to wait for: complete it now, through the same function the
  -- webhook will use.
  if v_status = 'completed' then
    perform finalize_sale(v_sale_id);
  end if;

  return v_sale_id;
end;
$$;

grant execute on function create_sale(uuid, uuid, uuid, text, numeric, jsonb, jsonb) to authenticated;

comment on function create_sale(uuid, uuid, uuid, text, numeric, jsonb, jsonb) is
  'Rings up a sale in one transaction: the sale and its lines (with the cost of each captured as at today), the stock movements that take the goods out, and one row per tender. Prices, tax rates and costs are read from the database, never accepted from the caller.';

-- ── create_refund(): current (0034) definition, numbering block only ────

create or replace function create_refund(
  p_sale_id uuid,
  p_cashier_id uuid,
  p_method text,
  p_reason text,
  p_items jsonb -- [{sale_item_id, quantity, restock}]
)
returns uuid
language plpgsql
as $$
declare
  v_sale        sales%rowtype;
  v_item        jsonb;
  v_line        sale_items%rowtype;
  v_qty         numeric(14, 3);
  v_already     numeric(14, 3);
  v_restock     boolean;
  v_refund_id   uuid;
  v_reference   text;
  v_line_total  numeric(14, 2);
  v_line_tax    numeric(14, 2);
  v_line_sub    numeric(14, 2);
  v_subtotal    numeric(14, 2) := 0;
  v_tax_total   numeric(14, 2) := 0;
  v_total       numeric(14, 2) := 0;
  v_lines       jsonb := '[]'::jsonb;
begin
  if p_items is null or jsonb_array_length(p_items) < 1 then
    raise exception 'Choose what is being returned' using errcode = 'P0001';
  end if;

  if p_method not in ('cash', 'credit') then
    raise exception 'Unknown refund method' using errcode = '22023';
  end if;

  -- Serialised per sale so two simultaneous returns cannot both pass the
  -- "how much is left?" check below and between them refund more than was
  -- sold. Deliberately an advisory lock and NOT SELECT ... FOR UPDATE: a
  -- row lock on `sales` is evaluated against the UPDATE policy, which
  -- requires sales.void, so refunding would have demanded the permission
  -- to void. (That is exactly how this was found.)
  perform pg_advisory_xact_lock(hashtextextended('sale_correction:' || p_sale_id::text, 0));

  select * into v_sale from sales where id = p_sale_id;

  if v_sale.id is null then
    raise exception 'Sale not found' using errcode = 'P0002';
  end if;
  if v_sale.status <> 'completed' then
    raise exception '%', case v_sale.status
      when 'voided' then 'This sale was voided; there is nothing to refund'
      when 'awaiting_payment' then 'This sale has not been paid for yet, so there is nothing to give back'
      when 'cancelled' then 'This sale was cancelled before it was paid for'
      else 'This sale cannot be refunded'
    end using errcode = 'P0001';
  end if;

  if p_method = 'credit' and v_sale.customer_id is null then
    raise exception 'This was a walk-in sale, so it can only be refunded in cash' using errcode = 'P0001';
  end if;

  if p_cashier_id is not null then
    if not exists (
      select 1 from profiles
      where id = p_cashier_id and business_id = v_sale.business_id and status = 'active'
    ) then
      raise exception 'Invalid cashier' using errcode = 'P0002';
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      continue;
    end if;

    select * into v_line from sale_items
    where id = (v_item ->> 'sale_item_id')::uuid and sale_id = p_sale_id;

    if v_line.id is null then
      raise exception 'That line is not part of this sale' using errcode = 'P0002';
    end if;

    v_already := sale_item_refunded_quantity(v_line.id);
    if v_qty + v_already > v_line.quantity then
      raise exception 'Only % of "%" is left to refund', v_line.quantity - v_already, v_line.description
        using errcode = 'P0001';
    end if;

    v_line_total := round(v_line.line_total * v_qty / v_line.quantity, 2);
    v_line_tax   := round(v_line.line_tax * v_qty / v_line.quantity, 2);
    v_line_sub   := v_line_total - v_line_tax;

    v_restock := coalesce((v_item ->> 'restock')::boolean, true);

    v_lines := v_lines || jsonb_build_object(
      'sale_item_id', v_line.id,
      'variant_id', v_line.variant_id,
      'quantity', v_qty,
      'unit_price', v_line.unit_price,
      'unit_cost', coalesce(v_line.unit_cost, 0),
      'line_subtotal', v_line_sub,
      'line_tax', v_line_tax,
      'line_total', v_line_total,
      'restock', v_restock
    );

    v_subtotal  := v_subtotal + v_line_sub;
    v_tax_total := v_tax_total + v_line_tax;
    v_total     := v_total + v_line_total;
  end loop;

  if jsonb_array_length(v_lines) = 0 then
    raise exception 'Choose what is being returned' using errcode = 'P0001';
  end if;

  -- Refund number, delegated to next_refund_number() (0038) for the same
  -- reason create_sale() delegates to next_receipt_number().
  perform pg_advisory_xact_lock(hashtextextended('refund:' || v_sale.business_id::text, 0));

  v_reference := next_refund_number(v_sale.business_id);

  insert into refunds (
    business_id, sale_id, refund_number, method, reason,
    subtotal, tax_total, total, cashier_id, created_by
  )
  values (
    v_sale.business_id, p_sale_id, v_reference, p_method, nullif(p_reason, ''),
    v_subtotal, v_tax_total, v_total, p_cashier_id, auth.uid()
  )
  returning id into v_refund_id;

  for v_item in select * from jsonb_array_elements(v_lines)
  loop
    insert into refund_items (
      refund_id, business_id, sale_item_id, variant_id, quantity,
      unit_price, unit_cost, line_subtotal, line_tax, line_total, restocked
    )
    values (
      v_refund_id, v_sale.business_id, (v_item ->> 'sale_item_id')::uuid,
      (v_item ->> 'variant_id')::uuid, (v_item ->> 'quantity')::numeric,
      (v_item ->> 'unit_price')::numeric, (v_item ->> 'unit_cost')::numeric,
      (v_item ->> 'line_subtotal')::numeric,
      (v_item ->> 'line_tax')::numeric, (v_item ->> 'line_total')::numeric,
      (v_item ->> 'restock')::boolean
    );

    if (v_item ->> 'restock')::boolean then
      insert into inventory_movements (
        business_id, branch_id, variant_id, quantity_delta, reason,
        reference_type, reference_id, note
      )
      values (
        '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
        v_sale.branch_id, (v_item ->> 'variant_id')::uuid, (v_item ->> 'quantity')::numeric,
        'sale_refund', 'refund', v_refund_id,
        'Returned on ' || v_reference
      );
    end if;
  end loop;

  if p_method = 'credit' and v_total > 0 then
    insert into customer_account_entries (
      business_id, customer_id, branch_id, amount, entry_type, reference_type, reference_id, note
    )
    values (
      '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
      v_sale.customer_id, v_sale.branch_id, -v_total, 'refund', 'refund', v_refund_id,
      'Refund ' || v_reference
    );
  end if;

  insert into notifications (business_id, branch_id, type, severity, reference_type, reference_id, actor_user_id, data)
  values (
    v_sale.business_id, v_sale.branch_id, 'refund_created', 'warning', 'sale', p_sale_id, (select auth.uid()),
    jsonb_build_object(
      'receipt_number', v_sale.receipt_number,
      'refund_number', v_reference,
      'total', v_total,
      'reason', nullif(p_reason, ''),
      'cashier_id', p_cashier_id
    )
  );

  return v_refund_id;
end;
$$;

grant execute on function create_refund(uuid, uuid, text, text, jsonb) to authenticated;

comment on function create_refund(uuid, uuid, text, text, jsonb) is
  'Prices and records a return against a completed sale: apportioned totals, stock back for restocked lines, an account credit if paid on account, and a refund_created notification — in one transaction. Never re-derives a price: every figure is carried from the sale line it is returning.';