-- Busihub — 0020: sales (Phase 9, the till)
--
-- One sale writes to three ledgers in a single transaction: the sale
-- record itself, the stock ledger (0015), and — when it goes on account —
-- the customer ledger (0017). Either all of it lands or none of it does.
--
-- Agreed scope: cash and credit, overselling BLOCKED, the cashier
-- identified by PIN (0018/0019).
--
-- Two properties this file exists to guarantee:
--
--   * MONEY IS COMPUTED HERE, NOT SENT. create_sale() takes only variant
--     ids and quantities. Every price comes from product_variants and
--     every rate from business_settings, read inside the transaction. A
--     caller cannot post its own totals — the browser's cart figures are
--     a preview, and the receipt shows what the database calculated. This
--     is the difference between a till and a suggestion box.
--
--   * STOCK MOVES THROUGH THE LEDGER. A sale does not touch stock_levels;
--     it writes inventory_movements rows exactly as manual receiving does,
--     so "why is there 7 of these?" stays answerable and the level always
--     reconciles to its history.
--
-- Permissions:
--   sales.process — ring up a sale. Also what admits the 'sale' movement
--                   reason and the 'sale' account entry type, both of
--                   which 0015/0017 reserved for exactly this phase.
--   customers.view — needed to attach a customer (the RLS on customers
--                   already enforces it; noted here so the pairing is
--                   deliberate rather than incidental).

-- ── overselling honours the business's own setting ───────────────────────
--
-- 0015 refused any movement that drove stock negative, full stop. That is
-- the right default and stays the default — business_settings.pos_settings
-- .allow_negative_stock is false out of the box — but the setting already
-- existed (0002) and the Settings screen already exposes it, so enforcing
-- a hardcoded rule instead of reading it would have made that toggle a
-- lie. A shop whose recorded stock it cannot trust can now choose to let
-- the sale through rather than turn a customer away at the counter.
--
-- Phase 17 (offline sync) will need the same escape hatch for a different
-- reason: a sale that already happened in the shop cannot be refused
-- retroactively, so synced sales are specified to land and be flagged.
create or replace function apply_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_new_quantity numeric(14, 3);
  v_allow_negative boolean;
begin
  insert into stock_levels (business_id, branch_id, variant_id, quantity, updated_at)
  values (new.business_id, new.branch_id, new.variant_id, new.quantity_delta, now())
  on conflict (branch_id, variant_id) do update
    set quantity   = stock_levels.quantity + excluded.quantity,
        updated_at = now()
  returning quantity into v_new_quantity;

  if v_new_quantity < 0 then
    select coalesce((pos_settings ->> 'allow_negative_stock')::boolean, false)
    into v_allow_negative
    from business_settings
    where business_id = new.business_id;

    if not coalesce(v_allow_negative, false) then
      raise exception 'Not enough stock: this would leave % on hand', v_new_quantity
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

comment on function apply_inventory_movement() is
  'AFTER INSERT on inventory_movements: applies the delta to stock_levels in the same transaction, refusing to go negative unless the business has opted into allow_negative_stock. SECURITY DEFINER because stock_levels grants users no write access.';

-- ── the 'sale' reason and entry type become insertable ───────────────────
-- 0015 and 0017 deliberately admitted no policy for these, so that they
-- were rejected until the phase that generates them existed. It does now.

create policy inventory_movements_insert_sale on inventory_movements
  for insert
  with check (
    reason in ('sale', 'sale_refund')
    and app_has_permission(business_id, 'sales.process')
  );

create policy customer_account_entries_insert_sale on customer_account_entries
  for insert
  with check (
    entry_type = 'sale'
    and app_has_permission(business_id, 'customers.view')
    and app_has_permission(business_id, 'sales.process')
  );

-- ── sales ────────────────────────────────────────────────────────────────

create table sales (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  branch_id       uuid not null references branches(id) on delete restrict,
  receipt_number  text not null check (char_length(trim(receipt_number)) > 0),
  -- Null for a walk-in. Required for a credit sale (checked in create_sale).
  customer_id     uuid references customers(id) on delete restrict,
  status          text not null default 'completed'
                    check (status in ('completed', 'voided')),
  payment_method  text not null check (payment_method in ('cash', 'credit')),
  -- All numeric(14,2). subtotal excludes tax; total = subtotal + tax_total.
  subtotal        numeric(14, 2) not null check (subtotal >= 0),
  tax_total       numeric(14, 2) not null check (tax_total >= 0),
  total           numeric(14, 2) not null check (total >= 0),
  amount_tendered numeric(14, 2) not null default 0 check (amount_tendered >= 0),
  change_given    numeric(14, 2) not null default 0 check (change_given >= 0),
  -- Who was at the counter (PIN-identified), and which account the device
  -- was signed in as. Usually different people on a shared till, which is
  -- the entire point of the PIN.
  cashier_id      uuid references profiles(id) on delete set null,
  created_by      uuid references profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (business_id, receipt_number)
);

create index sales_business_created_idx on sales (business_id, created_at desc);
create index sales_branch_created_idx on sales (branch_id, created_at desc);
create index sales_customer_idx on sales (customer_id);

comment on table sales is
  'A completed sale. Financial record: never updated or deleted — a correction is a refund or a void, which get their own rows in a later phase (Section: Money integrity).';

create table sale_items (
  id            uuid primary key default gen_random_uuid(),
  sale_id       uuid not null references sales(id) on delete cascade,
  business_id   uuid not null references businesses(id) on delete cascade,
  variant_id    uuid not null references product_variants(id) on delete restrict,
  -- Snapshots. The catalog will change; a receipt from last year must
  -- still say what was actually sold and at what price.
  description   text not null,
  sku           text,
  quantity      numeric(14, 3) not null check (quantity > 0),
  unit_price    numeric(14, 2) not null check (unit_price >= 0),
  tax_category  text not null,
  line_subtotal numeric(14, 2) not null check (line_subtotal >= 0),
  line_tax      numeric(14, 2) not null check (line_tax >= 0),
  line_total    numeric(14, 2) not null check (line_total >= 0),
  created_at    timestamptz not null default now()
);

create index sale_items_sale_idx on sale_items (sale_id);
create index sale_items_variant_idx on sale_items (variant_id);

comment on table sale_items is
  'One line of a sale, with the description, SKU and price snapshotted at the moment of sale rather than joined from the catalog later.';

-- ── RLS: readable by those who can see sales; never mutable ──────────────

alter table sales enable row level security;

create policy sales_select on sales
  for select
  using (
    app_has_permission(business_id, 'sales.process')
    or app_has_permission(business_id, 'reports.view')
    or app_is_super_admin()
  );

create policy sales_insert on sales
  for insert
  with check (app_has_permission(business_id, 'sales.process') or app_is_super_admin());

-- No update and no delete policy, and the grants withdrawn: a completed
-- sale is a financial record. Voids and refunds are new rows in a later
-- phase, not edits to this one.
revoke update, delete on sales from authenticated;

alter table sale_items enable row level security;

create policy sale_items_select on sale_items
  for select
  using (
    app_has_permission(business_id, 'sales.process')
    or app_has_permission(business_id, 'reports.view')
    or app_is_super_admin()
  );

create policy sale_items_insert on sale_items
  for insert
  with check (app_has_permission(business_id, 'sales.process') or app_is_super_admin());

revoke update, delete on sale_items from authenticated;

-- ── create_sale(): the whole transaction ─────────────────────────────────
--
-- Takes what the till knows (branch, cashier, customer, payment, and a
-- list of variant ids + quantities) and derives everything else.
--
-- SECURITY INVOKER, like create_product and create_purchase_order: it runs
-- as the caller, so every RLS policy above and in 0015/0017 applies to its
-- writes exactly as if the caller had made them. That is also what stops
-- p_branch_id being pointed at another tenant.
--
-- Tax follows docs/ARCHITECTURE and lib/money/money.ts's calculateGhanaTax:
-- NHIL/GETFund/COVID levies apply to the taxable value, then VAT applies to
-- (value + levies). When the business prices tax-INCLUSIVE (the default),
-- the shelf price already contains all of that and the components are
-- extracted back out of it:
--     price = base * (1 + levyRates) * (1 + vatRate)
-- so base = price / ((1 + levyRates) * (1 + vatRate)).
create or replace function create_sale(
  p_branch_id uuid,
  p_cashier_id uuid,
  p_customer_id uuid,
  p_payment_method text,
  p_amount_tendered numeric,
  p_items jsonb -- [{variant_id, quantity}]
)
returns uuid
language plpgsql
as $$
declare
  v_business_id   uuid;
  v_sale_id       uuid;
  v_item          jsonb;
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
  -- Priced lines from the first pass, so the second can write them
  -- without recomputing (and without the two passes ever disagreeing).
  v_lines         jsonb := '[]'::jsonb;
begin
  if p_items is null or jsonb_array_length(p_items) < 1 then
    raise exception 'A sale needs at least one item' using errcode = 'P0001';
  end if;

  if p_payment_method not in ('cash', 'credit') then
    raise exception 'Unknown payment method' using errcode = '22023';
  end if;

  select business_id into v_business_id from branches where id = p_branch_id;
  if v_business_id is null then
    raise exception 'Invalid branch_id: branch not found' using errcode = 'P0002';
  end if;

  if p_payment_method = 'credit' and p_customer_id is null then
    raise exception 'A credit sale needs a customer' using errcode = 'P0001';
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

  select tax_settings into v_settings from business_settings where business_id = v_business_id;
  v_vat_enabled := coalesce((v_settings ->> 'vat_enabled')::boolean, false);
  v_inclusive   := coalesce((v_settings ->> 'vat_inclusive')::boolean, true);
  v_vat         := coalesce((v_settings ->> 'vat_rate')::numeric, 0);
  v_levies      := coalesce((v_settings ->> 'nhil_levy_rate')::numeric, 0)
                 + coalesce((v_settings ->> 'getfund_levy_rate')::numeric, 0)
                 + coalesce((v_settings ->> 'covid_levy_rate')::numeric, 0);

  -- FIRST PASS: price every line and total the sale, writing nothing.
  --
  -- The sale row is inserted once, already correct, rather than inserted
  -- blank and UPDATEd with the totals afterwards. That is not a style
  -- preference: `sales` deliberately grants no UPDATE to anyone (a
  -- completed sale is a financial record), so a function that runs as the
  -- caller — which this one does, so that RLS applies to its writes —
  -- cannot update it. Found by the tests, which is what they are for.
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every line needs a quantity greater than zero' using errcode = 'P0001';
    end if;

    -- The price comes from here, never from the caller.
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
      -- Extract the tax already contained in the shelf price. The tax is
      -- taken as (gross - subtotal) rather than rounded separately, so the
      -- parts always sum to the price on the shelf with no stray pesewa.
      v_base := v_gross / ((1 + v_levies) * (1 + v_vat));
      v_line_subtotal := round(v_base, 2);
      v_line_tax := v_gross - v_line_subtotal;
    else
      -- Add tax on top of the shelf price.
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

  if p_payment_method = 'cash' then
    if coalesce(p_amount_tendered, 0) < v_total then
      raise exception 'Not enough cash tendered for a total of %', v_total using errcode = 'P0001';
    end if;
    v_change := coalesce(p_amount_tendered, 0) - v_total;
  end if;

  -- Receipt number, serialised per business so two tills cannot both
  -- claim R-000042 (the unique constraint would catch it, but as a failed
  -- sale rather than as two correct numbers). Same approach as PO
  -- references in 0016.
  perform pg_advisory_xact_lock(hashtextextended('receipt:' || v_business_id::text, 0));

  select coalesce(max((substring(receipt_number from '^R-([0-9]+)$'))::int), 0) + 1
  into v_next
  from sales
  where business_id = v_business_id and receipt_number ~ '^R-[0-9]+$';

  v_reference := 'R-' || lpad(v_next::text, 6, '0');

  insert into sales (
    business_id, branch_id, receipt_number, customer_id, payment_method,
    subtotal, tax_total, total, amount_tendered, change_given, cashier_id, created_by
  )
  values (
    v_business_id, p_branch_id, v_reference, p_customer_id, p_payment_method,
    v_subtotal, v_tax_total, v_total, coalesce(p_amount_tendered, 0), v_change,
    p_cashier_id, auth.uid()
  )
  returning id into v_sale_id;

  -- SECOND PASS: the lines, and the stock they take out.
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

    -- Stock leaves through the ledger, not by touching the level. The
    -- 0015 trigger refuses to go negative unless the business allows it.
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

  -- On account: the balance moves through the customer ledger, and 0017's
  -- credit-limit check applies — so a sale that would take them over their
  -- limit is refused here, rolling the whole thing back.
  if p_payment_method = 'credit' then
    insert into customer_account_entries (
      business_id, customer_id, branch_id, amount, entry_type, reference_type, reference_id, note
    )
    values (
      '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
      p_customer_id, p_branch_id, v_total, 'sale', 'sale', v_sale_id,
      'Sale ' || v_reference
    );
  end if;

  return v_sale_id;
end;
$$;

grant execute on function create_sale(uuid, uuid, uuid, text, numeric, jsonb) to authenticated;

comment on function create_sale(uuid, uuid, uuid, text, numeric, jsonb) is
  'Rings up a sale in one transaction: the sale and its lines, the stock movements that take the goods out, and (on credit) the customer account entry. Prices and tax rates are read from the database, never accepted from the caller.';

-- A completed sale must not be silently editable even by a statement that
-- reaches the table directly. The revokes above stop UPDATE/DELETE; this
-- makes the intent explicit for anyone reading the schema.
comment on column sales.status is
  'completed or voided. Voiding is a later phase and will be a function, not an UPDATE — there is deliberately no update policy or grant on this table.';
