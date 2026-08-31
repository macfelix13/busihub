-- Busihub — 0029: what a sale COST, recorded when it happens
--
-- The dashboard is asked for gross profit. Profit needs cost, and until
-- now a sale recorded only its price. The cost was reachable — via the
-- variant's current cost_price — but "current" is the problem: cost
-- prices change, and applying today's cost to last month's sale does not
-- give a rounder answer, it gives a wrong one. A supplier raising a price
-- would silently rewrite last quarter's margins.
--
-- So the cost is snapshotted onto the sale line at the moment of sale,
-- exactly as the price already is. A refund carries the same cost back,
-- so returning goods removes the cost it added rather than today's.
--
-- HISTORY IS ESTIMATED, AND SAYS SO. Sales rung up before this migration
-- have no cost recorded and never can — the information was not kept.
-- They are backfilled from the variant's cost today and flagged
-- `cost_is_estimated`, so a profit report can state which figures are
-- exact and which are an approximation, rather than mixing the two and
-- presenting the result as fact.
--
-- Also here: `reorder_point`, a per-product minimum stock level. The
-- dashboard's low-stock section needs "below ITS minimum", not "below one
-- number the whole shop shares" — 5 bags of rice and 5 crates of drinks
-- are not the same situation.

alter table sale_items
  add column if not exists unit_cost numeric(14, 2) not null default 0,
  add column if not exists cost_is_estimated boolean not null default false;

comment on column sale_items.unit_cost is
  'What one unit cost the business, captured at the moment of sale. Never re-read from the catalog afterwards: cost prices change, and profit on a past sale must not.';
comment on column sale_items.cost_is_estimated is
  'True for sales that predate cost capture (migration 0029), whose cost was inferred from the catalog afterwards. Profit for these is an approximation and must be reported as one.';

alter table refund_items
  add column if not exists unit_cost numeric(14, 2) not null default 0;

comment on column refund_items.unit_cost is
  'Carried from the sale line being returned, so a return removes the cost it originally added.';

alter table product_variants
  add column if not exists reorder_point numeric(14, 3);

comment on column product_variants.reorder_point is
  'Minimum stock for THIS product before it counts as low. Null means fall back to the business-wide threshold in business_settings.inventory_settings.';

-- ── backfill, clearly marked as an estimate ─────────────────────────────

update sale_items si
set unit_cost = coalesce(v.cost_price, 0),
    cost_is_estimated = true
from product_variants v
where v.id = si.variant_id
  and si.unit_cost = 0
  and coalesce(v.cost_price, 0) > 0;

update refund_items ri
set unit_cost = si.unit_cost
from sale_items si
where si.id = ri.sale_item_id
  and ri.unit_cost = 0;

do $$
declare v_estimated int; v_total int;
begin
  select count(*) filter (where cost_is_estimated), count(*) into v_estimated, v_total from sale_items;
  raise notice 'Cost backfill: % of % sale lines are estimated from the current catalog; everything sold from now on records its own cost.',
    v_estimated, v_total;
end $$;

-- ── capture the cost at the moment of sale ──────────────────────────────

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
  v_next          int;
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
  -- claim R-000042.
  perform pg_advisory_xact_lock(hashtextextended('receipt:' || v_business_id::text, 0));

  select coalesce(max((substring(receipt_number from '^R-([0-9]+)$'))::int), 0) + 1
  into v_next
  from sales
  where business_id = v_business_id and receipt_number ~ '^R-[0-9]+$';

  v_reference := 'R-' || lpad(v_next::text, 6, '0');

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

-- ── and carry it back on a return ───────────────────────────────────────

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
  v_next        int;
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

  -- Putting money back on an account only makes sense if there is an
  -- account to put it on.
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

  -- FIRST PASS: price the return, writing nothing. Same reasoning as
  -- create_sale — refunds grant no UPDATE either, so the row is inserted
  -- once with its totals already correct.
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      continue; -- a line with nothing coming back is skipped, not an error
    end if;

    select * into v_line from sale_items
    where id = (v_item ->> 'sale_item_id')::uuid and sale_id = p_sale_id;

    if v_line.id is null then
      raise exception 'That line is not part of this sale' using errcode = 'P0002';
    end if;

    -- Cumulative across every previous refund, so three separate returns
    -- of one cannot exceed a quantity of three.
    v_already := sale_item_refunded_quantity(v_line.id);
    if v_qty + v_already > v_line.quantity then
      raise exception 'Only % of "%" is left to refund', v_line.quantity - v_already, v_line.description
        using errcode = 'P0001';
    end if;

    -- Apportion what was actually charged. line_subtotal is derived as
    -- (total - tax) so the parts still sum exactly, as they do on a sale.
    v_line_total := round(v_line.line_total * v_qty / v_line.quantity, 2);
    v_line_tax   := round(v_line.line_tax * v_qty / v_line.quantity, 2);
    v_line_sub   := v_line_total - v_line_tax;

    v_restock := coalesce((v_item ->> 'restock')::boolean, true);

    v_lines := v_lines || jsonb_build_object(
      'sale_item_id', v_line.id,
      'variant_id', v_line.variant_id,
      'quantity', v_qty,
      'unit_price', v_line.unit_price,
      -- Carried from the sale line, so a return removes the same cost it
      -- added. Taking today's cost here would make profit drift every
      -- time a supplier changed their price.
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

  -- Nothing was actually selected. Deliberately counts LINES rather than
  -- testing v_total <= 0: a line sold at zero (a promotional give-away)
  -- refunds no money but still has to come back onto the shelf, and a
  -- total-based guard would have refused that return outright.
  if jsonb_array_length(v_lines) = 0 then
    raise exception 'Choose what is being returned' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('refund:' || v_sale.business_id::text, 0));

  select coalesce(max((substring(refund_number from '^RF-([0-9]+)$'))::int), 0) + 1
  into v_next
  from refunds
  where business_id = v_sale.business_id and refund_number ~ '^RF-[0-9]+$';

  v_reference := 'RF-' || lpad(v_next::text, 6, '0');

  insert into refunds (
    business_id, sale_id, refund_number, method, reason,
    subtotal, tax_total, total, cashier_id, created_by
  )
  values (
    v_sale.business_id, p_sale_id, v_reference, p_method, nullif(p_reason, ''),
    v_subtotal, v_tax_total, v_total, p_cashier_id, auth.uid()
  )
  returning id into v_refund_id;

  -- SECOND PASS: the lines, and the stock that comes back with them.
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

    -- Damaged goods are refunded but never returned to the shelf.
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

  -- Back onto the account, reducing what they owe. A give-away return
  -- moves no money, and the ledger refuses a zero entry, so there is
  -- nothing to write.
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

  return v_refund_id;
end;
$$;

grant execute on function create_refund(uuid, uuid, text, text, jsonb) to authenticated;

comment on function create_refund(uuid, uuid, text, text, jsonb) is
  'Refunds specific lines of a sale, in one transaction: the refund and its lines, the stock coming back (unless the goods are damaged), and the account credit when it goes back on account. Amounts AND costs are apportioned from what was actually charged and what it actually cost, never recomputed from current prices.';

-- ── takings, now with cost of goods and gross profit ────────────────────
--
-- Return type changes, so the old one is dropped rather than replaced.
-- Still SECURITY INVOKER: RLS decides whose sales are counted (0027).

drop function if exists sales_summary(timestamptz, timestamptz, text, uuid);

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
  net_total numeric,
  cost_total numeric,
  gross_profit numeric,
  items_sold numeric,
  any_cost_estimated boolean
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
  -- Goods that came back take their cost back out with them, so profit
  -- reflects what was actually kept.
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
    -- Gross profit = net sales less the cost of what was actually sold.
    -- Operating expenses are NOT in here: that is net profit, and Busihub
    -- has no expenses table yet, so claiming it would be a fabrication.
    ((select coalesce(sum(total), 0) from filtered) - (select amount from returned))
      - ((select cost from lines) - (select cost from returned)),
    (select units from lines),
    (select coalesce(estimated, false) from lines);
$$;

grant execute on function sales_summary(timestamptz, timestamptz, text, uuid) to authenticated;

comment on function sales_summary(timestamptz, timestamptz, text, uuid) is
  'Takings for a filtered period: completed sales, what they came to, what was returned, the net, the cost of goods actually sold, and the resulting GROSS profit — gross, not net: operating expenses are not modelled yet. any_cost_estimated is true when any line in the period predates cost capture, so a report can say so. Runs as the caller, so RLS scopes it.';