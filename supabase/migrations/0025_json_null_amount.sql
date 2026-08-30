-- Busihub — 0025: "no amount" means no amount, however it is written
--
-- A real bug, found the first time a cashier took mobile money in the
-- browser. It is worth writing down exactly, because the mistake is easy
-- to make again and invisible in a passing test suite.
--
-- 0022 and 0024 spelled "the caller did not give an amount" as
--
--     (v_pay -> 'amount') is null
--
-- In PostgreSQL, `jsonb -> 'key'` returns SQL NULL only when the key is
-- ABSENT. When the key is present holding a JSON null it returns the
-- jsonb value `null`, which is not SQL NULL:
--
--     select ('{"amount": null}'::jsonb -> 'amount') is null;  -- false
--     select ('{}'::jsonb            -> 'amount') is null;     -- true
--
-- The till sends `{"method":"momo","amount":null,...}` — an explicit null,
-- because that is what JSON.stringify does with a null property. So the
-- "work out what is left to charge" branch never ran, execution fell
-- through to the branch that reads the amount, and every mobile money
-- sale was refused with "Every payment needs an amount greater than zero".
--
-- Every assertion in tests/security/payments.sql passed throughout,
-- because they build their payload with jsonb_build_object and simply
-- omit the key — the absent case, which always worked. The test suite was
-- testing a payload shape the application never sends. Assertions using
-- an explicit null are added alongside this migration.
--
-- Both branches now ask jsonb_typeof, which answers 'null' for a JSON
-- null and SQL NULL for an absent key: coalesce folds the two together,
-- so the caller may say either and mean the same thing.

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

    select v.id, v.sku, v.selling_price, v.status, p.name, p.tax_category
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
      unit_price, tax_category, line_subtotal, line_tax, line_total
    )
    values (
      v_sale_id, v_business_id, (v_item ->> 'variant_id')::uuid,
      v_item ->> 'description', v_item ->> 'sku', (v_item ->> 'quantity')::numeric,
      (v_item ->> 'unit_price')::numeric, v_item ->> 'tax_category',
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
  'Rings up a sale in one transaction: the sale and its lines, the stock movements that take the goods out, and one row per tender. Prices and tax rates are read from the database, never accepted from the caller. A sale with a mobile money tender is left awaiting_payment until settle_sale_payment() reports the charge succeeded.';

-- ── can this till offer mobile money? ───────────────────────────────────
--
-- The till has to know, and a cashier cannot read business_payment_settings
-- — that table is owner-only, which is right: it holds the keys.
--
-- Widening the policy so a cashier could read the row would hand them the
-- public key, the mode and four characters of the secret to answer a
-- yes/no question. So exactly one bit is exposed instead, behind a
-- function that checks the caller works this till.

create or replace function business_momo_enabled(p_business_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_enabled boolean;
begin
  if not (
    app_has_permission(p_business_id, 'sales.process')
    or app_has_permission(p_business_id, 'business.manage')
    or app_is_super_admin()
  ) then
    return false;
  end if;

  -- Switched on AND actually connected: the flag alone would offer a
  -- payment method that fails the moment a customer is standing there.
  select s.momo_enabled and s.paystack_secret_cipher is not null
  into v_enabled
  from business_payment_settings s
  where s.business_id = p_business_id;

  return coalesce(v_enabled, false);
end;
$$;

revoke all on function business_momo_enabled(uuid) from public, anon;
grant execute on function business_momo_enabled(uuid) to authenticated;

comment on function business_momo_enabled(uuid) is
  'Whether this business can take mobile money right now: switched on and with a Paystack account connected. One bit, so the till can decide what to offer without reading the keys.';
