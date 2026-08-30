-- Busihub — 0021: refunds & voids (Phase 12, brought forward)
--
-- Until now a completed sale was permanently immutable. That is the right
-- instinct for a financial record, but taken alone it means a cashier who
-- rings up the wrong item has no remedy at all. The answer is not to make
-- sales editable — it is to give the two corrections that actually happen
-- behind a counter their own rows:
--
--   VOID   — "that sale should never have happened". Cancels the whole
--            thing: every item back to stock, any account charge reversed,
--            and the sale marked voided. For a mistake at the till, not
--            for a customer changing their mind.
--
--   REFUND — "the customer brought something back". Specific lines, in
--            specific quantities, at the price they actually paid — never
--            at today's catalog price. Partial by default, because one
--            item coming back out of five is the normal case.
--
-- Both are new rows referencing the original sale. Nothing about the sale
-- is rewritten except its status, which is the one field a void changes.
--
-- Permissions (both already in the 0010 catalog; Owner and Manager hold
-- them, Cashier deliberately does not):
--   sales.void   — cancel a sale outright.
--   sales.refund — take goods back and return the money.
--
-- ── a correction to 0020 ────────────────────────────────────────────────
-- 0020 admitted both 'sale' and 'sale_refund' movements on sales.process.
-- That is too loose: it would let a cashier put stock back — the inventory
-- half of a refund — without holding sales.refund. Separated below.

drop policy inventory_movements_insert_sale on inventory_movements;

create policy inventory_movements_insert_sale on inventory_movements
  for insert
  with check (reason = 'sale' and app_has_permission(business_id, 'sales.process'));

create policy inventory_movements_insert_refund on inventory_movements
  for insert
  with check (reason = 'sale_refund' and app_has_permission(business_id, 'sales.refund'));

-- 0017 reserved the 'refund' account entry type for exactly this phase.
create policy customer_account_entries_insert_refund on customer_account_entries
  for insert
  with check (
    entry_type = 'refund'
    and app_has_permission(business_id, 'customers.view')
    and app_has_permission(business_id, 'sales.refund')
  );

-- ── voiding needs the one column it changes ─────────────────────────────
--
-- 0020 revoked UPDATE on sales entirely. Rather than reopening the table
-- or reaching for SECURITY DEFINER (which would bypass the RLS that makes
-- everything else safe), exactly one column is granted back. A table-level
-- revoke followed by a column-level grant works the way you would hope —
-- unlike the reverse, which silently does nothing (see 0018).
grant update (status) on sales to authenticated;

create policy sales_update_status on sales
  for update
  using (app_has_permission(business_id, 'sales.void') or app_is_super_admin())
  with check (app_has_permission(business_id, 'sales.void') or app_is_super_admin());

create or replace function enforce_sale_status_rules()
returns trigger
language plpgsql
as $$
begin
  -- Only ever completed -> voided. Not back again, and nothing else.
  if new.status is distinct from old.status then
    if not (old.status = 'completed' and new.status = 'voided') then
      raise exception 'A sale can only go from completed to voided' using errcode = 'P0001';
    end if;
    if not (app_has_permission(new.business_id, 'sales.void') or app_is_super_admin()) then
      raise exception 'Missing permission: sales.void' using errcode = '42501';
    end if;
  end if;

  -- Everything else about a sale stays frozen even though the column
  -- grant above is narrow; belt and braces, and it documents the intent.
  if (new.total, new.subtotal, new.tax_total, new.receipt_number, new.customer_id,
      new.branch_id, new.payment_method, new.cashier_id)
     is distinct from
     (old.total, old.subtotal, old.tax_total, old.receipt_number, old.customer_id,
      old.branch_id, old.payment_method, old.cashier_id) then
    raise exception 'A completed sale cannot be edited' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger enforce_sale_status
  before update on sales
  for each row execute function enforce_sale_status_rules();

-- ── refunds ─────────────────────────────────────────────────────────────

create table refunds (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id) on delete cascade,
  sale_id        uuid not null references sales(id) on delete restrict,
  refund_number  text not null check (char_length(trim(refund_number)) > 0),
  -- How the money went back. 'credit' reduces what the customer owes,
  -- which is the only sensible answer when they never paid cash.
  method         text not null check (method in ('cash', 'credit')),
  reason         text,
  subtotal       numeric(14, 2) not null check (subtotal >= 0),
  tax_total      numeric(14, 2) not null check (tax_total >= 0),
  -- >= 0, not > 0: a promotional line sold at 0.00 refunds no money but
  -- still has to come back onto the shelf, and that return is a refund
  -- like any other. create_refund() refuses a return with no lines, which
  -- is the case a "> 0" check was really reaching for.
  total          numeric(14, 2) not null check (total >= 0),
  cashier_id     uuid references profiles(id) on delete set null,
  created_by     uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (business_id, refund_number)
);

create index refunds_sale_idx on refunds (sale_id);
create index refunds_business_created_idx on refunds (business_id, created_at desc);

comment on table refunds is
  'Money and goods going back. A refund never edits the sale it references — the sale stays exactly as it was rung up.';

create table refund_items (
  id           uuid primary key default gen_random_uuid(),
  refund_id    uuid not null references refunds(id) on delete cascade,
  business_id  uuid not null references businesses(id) on delete cascade,
  sale_item_id uuid not null references sale_items(id) on delete restrict,
  variant_id   uuid not null references product_variants(id) on delete restrict,
  quantity     numeric(14, 3) not null check (quantity > 0),
  -- Snapshotted from the ORIGINAL sale line. A customer is refunded what
  -- they paid, not what the item costs today.
  unit_price   numeric(14, 2) not null check (unit_price >= 0),
  line_subtotal numeric(14, 2) not null check (line_subtotal >= 0),
  line_tax      numeric(14, 2) not null check (line_tax >= 0),
  line_total    numeric(14, 2) not null check (line_total >= 0),
  -- Damaged goods come back to the shop but not to the shelf.
  restocked    boolean not null default true,
  created_at   timestamptz not null default now()
);

create index refund_items_refund_idx on refund_items (refund_id);
create index refund_items_sale_item_idx on refund_items (sale_item_id);

comment on table refund_items is
  'One refunded line. restocked = false for goods that came back damaged: the customer is still refunded, but the stock does not return to the shelf.';

-- ── RLS ─────────────────────────────────────────────────────────────────

alter table refunds enable row level security;

create policy refunds_select on refunds
  for select
  using (
    app_has_permission(business_id, 'sales.process')
    or app_has_permission(business_id, 'reports.view')
    or app_is_super_admin()
  );

create policy refunds_insert on refunds
  for insert
  with check (app_has_permission(business_id, 'sales.refund') or app_is_super_admin());

revoke update, delete on refunds from authenticated;

alter table refund_items enable row level security;

create policy refund_items_select on refund_items
  for select
  using (
    app_has_permission(business_id, 'sales.process')
    or app_has_permission(business_id, 'reports.view')
    or app_is_super_admin()
  );

create policy refund_items_insert on refund_items
  for insert
  with check (app_has_permission(business_id, 'sales.refund') or app_is_super_admin());

revoke update, delete on refund_items from authenticated;

-- ── how much of a line is still refundable ──────────────────────────────

create or replace function sale_item_refunded_quantity(p_sale_item_id uuid)
returns numeric
language sql
stable
as $$
  select coalesce(sum(quantity), 0) from refund_items where sale_item_id = p_sale_item_id;
$$;

comment on function sale_item_refunded_quantity(uuid) is
  'How much of one sale line has already gone back, across every refund against it. Cumulative, so three separate one-item returns cannot exceed a quantity of three.';

-- ── void_sale() ─────────────────────────────────────────────────────────

create or replace function void_sale(p_sale_id uuid, p_reason text default null)
returns void
language plpgsql
as $$
declare
  v_sale sales%rowtype;
  v_item sale_items%rowtype;
  v_rows int;
begin
  -- An advisory lock rather than SELECT ... FOR UPDATE. A row lock on
  -- `sales` would force the row through the UPDATE policy, which requires
  -- sales.void — so a caller without it gets "Sale not found" instead of
  -- a permission error, and (worse) any function that only READS the sale
  -- would break for everyone else. The advisory lock serialises the same
  -- thing without touching row-level policy.
  perform pg_advisory_xact_lock(hashtextextended('sale_correction:' || p_sale_id::text, 0));

  select * into v_sale from sales where id = p_sale_id;

  if v_sale.id is null then
    raise exception 'Sale not found' using errcode = 'P0002';
  end if;

  -- Checked HERE, up front, not left to the UPDATE at the end. An
  -- RLS-denied UPDATE does not raise — it matches zero rows silently — so
  -- without this a caller holding sales.refund but not sales.void would
  -- write every stock-reversal movement below and then fail to mark the
  -- sale voided, leaving the goods back on the shelf and the sale still
  -- standing. Found by testing exactly that role.
  if not (app_has_permission(v_sale.business_id, 'sales.void') or app_is_super_admin()) then
    raise exception 'Missing permission: sales.void' using errcode = '42501';
  end if;

  -- Named per status rather than assuming the only other one is 'voided'.
  -- 0022 adds two more, and a cashier told "this sale has already been
  -- voided" about a sale that is simply waiting for a momo prompt would
  -- go looking for a void that never happened.
  if v_sale.status <> 'completed' then
    raise exception '%', case v_sale.status
      when 'voided' then 'This sale has already been voided'
      when 'awaiting_payment' then 'This sale is still waiting for payment — cancel it instead'
      when 'cancelled' then 'This sale was cancelled before it was paid for'
      else 'This sale cannot be voided'
    end using errcode = 'P0001';
  end if;

  -- A sale that has been partly refunded has already had money and stock
  -- moved against it. Voiding it too would double the reversal, so the
  -- two corrections are deliberately exclusive.
  if exists (select 1 from refunds where sale_id = p_sale_id) then
    raise exception 'This sale has been refunded and cannot be voided. Refund the rest instead.'
      using errcode = 'P0001';
  end if;

  -- Everything goes back on the shelf: a void means the sale never
  -- happened, so there is no damaged-goods case to consider.
  for v_item in select * from sale_items where sale_id = p_sale_id
  loop
    insert into inventory_movements (
      business_id, branch_id, variant_id, quantity_delta, reason,
      reference_type, reference_id, note
    )
    values (
      '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
      v_sale.branch_id, v_item.variant_id, v_item.quantity, 'sale_refund',
      'sale_void', p_sale_id,
      'Void of ' || v_sale.receipt_number || coalesce(' — ' || nullif(p_reason, ''), '')
    );
  end loop;

  -- An on-account sale put the total onto the customer's balance; voiding
  -- takes it off again.
  if v_sale.payment_method = 'credit' and v_sale.customer_id is not null then
    insert into customer_account_entries (
      business_id, customer_id, branch_id, amount, entry_type, reference_type, reference_id, note
    )
    values (
      '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
      v_sale.customer_id, v_sale.branch_id, -v_sale.total, 'refund',
      'sale_void', p_sale_id,
      'Void of ' || v_sale.receipt_number
    );
  end if;

  update sales set status = 'voided' where id = p_sale_id;

  -- The permission check above should make this unreachable; it exists
  -- because the failure mode it catches is silent data corruption rather
  -- than an error, and that is worth two lines.
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'Could not void this sale' using errcode = '42501';
  end if;
end;
$$;

grant execute on function void_sale(uuid, text) to authenticated;

comment on function void_sale(uuid, text) is
  'Cancels a whole sale: every item back to stock, any account charge reversed, status set to voided — in one transaction. Refused if the sale has already been partly refunded, since that would double the reversal.';

-- ── create_refund() ─────────────────────────────────────────────────────
--
-- Takes the sale lines being returned and how much of each. Money comes
-- from the ORIGINAL line, apportioned by quantity: refunding 2 of 5 gives
-- back two fifths of what was actually charged, tax included. The tax
-- share is taken from the line's recorded tax rather than recomputed, so
-- a later change to the business's VAT rate cannot alter what an old sale
-- is refunded at.
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
      unit_price, line_subtotal, line_tax, line_total, restocked
    )
    values (
      v_refund_id, v_sale.business_id, (v_item ->> 'sale_item_id')::uuid,
      (v_item ->> 'variant_id')::uuid, (v_item ->> 'quantity')::numeric,
      (v_item ->> 'unit_price')::numeric, (v_item ->> 'line_subtotal')::numeric,
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
  'Refunds specific lines of a sale, in one transaction: the refund and its lines, the stock coming back (unless the goods are damaged), and the account credit when it goes back on account. Amounts are apportioned from what was actually charged, never recomputed from current prices.';
