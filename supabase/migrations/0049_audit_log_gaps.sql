-- Busihub — 0049: audit logging for refunds, voids, and the other
-- sensitive mutations that were never wired to log_audit_event()
-- (security-audit Gaps #2 and #5, 2026-09 review).
--
-- log_audit_event() (0008) has existed since the earliest phases and is
-- the one sanctioned write path to audit_logs — staff invites/role
-- changes/deactivation (0036), payment settings changes, till no-sale
-- events, and Super Admin actions all already go through it. Two of the
-- most fraud-relevant actions in the whole app did not:
--
--   - void_sale()    (0021, redefined 0034) — reversing a completed sale
--   - create_refund() (0021, redefined 0039/0040) — returning goods/money
--
-- Refunds and voids are the classic point-of-sale fraud vector, and until
-- now there was no audit trail at all of who reversed a sale or when —
-- ranked High in the audit specifically because of that.
--
-- Also unwired: void_expense() (0031), and (at the application layer,
-- see the accompanying app/**/actions.ts changes shipped alongside this
-- migration) customer credit-limit changes, branch create/edit, and
-- business profile/settings changes.
--
-- Both SQL functions below are reproduced in full from their current live
-- bodies (void_sale from 0034, create_refund from 0040) — unchanged
-- except for one `perform log_audit_event(...)` call added at the point
-- each already knows everything it needs to describe what happened, same
-- placement as the notification inserts those same functions already
-- make. void_expense (unchanged since 0031) gets the same treatment.

-- ── void_sale(): now also writes an audit_logs row ────────────────────────

create or replace function void_sale(p_sale_id uuid, p_reason text default null)
returns void
language plpgsql
as $$
declare
  v_sale sales%rowtype;
  v_item sale_items%rowtype;
  v_rows int;
begin
  perform pg_advisory_xact_lock(hashtextextended('sale_correction:' || p_sale_id::text, 0));

  select * into v_sale from sales where id = p_sale_id;

  if v_sale.id is null then
    raise exception 'Sale not found' using errcode = 'P0002';
  end if;

  if not (app_has_permission(v_sale.business_id, 'sales.void') or app_is_super_admin()) then
    raise exception 'Missing permission: sales.void' using errcode = '42501';
  end if;

  if v_sale.status <> 'completed' then
    raise exception '%', case v_sale.status
      when 'voided' then 'This sale has already been voided'
      when 'awaiting_payment' then 'This sale is still waiting for payment — cancel it instead'
      when 'cancelled' then 'This sale was cancelled before it was paid for'
      else 'This sale cannot be voided'
    end using errcode = 'P0001';
  end if;

  if exists (select 1 from refunds where sale_id = p_sale_id) then
    raise exception 'This sale has been refunded and cannot be voided. Refund the rest instead.'
      using errcode = 'P0001';
  end if;

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

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'Could not void this sale' using errcode = '42501';
  end if;

  -- The notification insert's own WITH CHECK re-derives business_id from
  -- app_current_business_id() and requires sales.void — both already
  -- true, since we could not have reached here otherwise — so this can
  -- only fail if the two ever drift, which is exactly what
  -- tests/security/notifications.sql's sabotage cases are for.
  insert into notifications (business_id, branch_id, type, severity, reference_type, reference_id, actor_user_id, data)
  values (
    v_sale.business_id, v_sale.branch_id, 'sale_voided', 'warning', 'sale', p_sale_id, (select auth.uid()),
    jsonb_build_object(
      'receipt_number', v_sale.receipt_number,
      'total', v_sale.total,
      'reason', nullif(p_reason, ''),
      'cashier_id', v_sale.cashier_id
    )
  );

  -- NEW in 0049: the audit trail this function never had (Gap #2). Same
  -- SECURITY DEFINER write path every other sensitive action already
  -- uses (0008) — business_id/branch_id come from the sale itself, never
  -- from the caller, and the actor is always auth.uid() inside
  -- log_audit_event() regardless of what runs this function.
  perform log_audit_event(
    v_sale.business_id, v_sale.branch_id, 'sale.voided', 'sale', p_sale_id,
    jsonb_build_object(
      'receipt_number', v_sale.receipt_number,
      'total', v_sale.total,
      'reason', nullif(p_reason, ''),
      'cashier_id', v_sale.cashier_id
    )
  );
end;
$$;

grant execute on function void_sale(uuid, text) to authenticated;

comment on function void_sale(uuid, text) is
  'Cancels a whole sale: every item back to stock, any account charge reversed, status set to voided, a sale_voided notification, and (0049) a sale.voided audit_logs row — in one transaction. Refused if the sale has already been partly refunded, since that would double the reversal.';

-- ── create_refund(): now also writes an audit_logs row ────────────────────
--
-- Reproduced from 0040's current live body (the service-line-is-never-
-- restocked fix, itself layered on 0039's cashier_id-is-always-the-caller
-- fix) — unchanged except for the log_audit_event() call added right
-- before the return, alongside the notification insert 0034 already
-- added there.

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
  -- From 0040: whether the sale line being returned was a service — there
  -- is nothing to put back on a shelf for one, no matter what the
  -- caller's restock flag says.
  v_is_service  boolean;
begin
  if p_items is null or jsonb_array_length(p_items) < 1 then
    raise exception 'Choose what is being returned' using errcode = 'P0001';
  end if;

  if p_method not in ('cash', 'credit') then
    raise exception 'Unknown refund method' using errcode = '22023';
  end if;

  -- The cashier is always whoever is actually signed in — never a value
  -- the client chooses (0039). Same reasoning as create_sale().
  if p_cashier_id is not null and p_cashier_id <> auth.uid() then
    raise exception 'A refund can only be attributed to the account that is signed in' using errcode = '42501';
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

    select (p.type = 'service') into v_is_service
    from product_variants pv join products p on p.id = pv.product_id
    where pv.id = v_line.variant_id;

    v_already := sale_item_refunded_quantity(v_line.id);
    if v_qty + v_already > v_line.quantity then
      raise exception 'Only % of "%" is left to refund', v_line.quantity - v_already, v_line.description
        using errcode = 'P0001';
    end if;

    v_line_total := round(v_line.line_total * v_qty / v_line.quantity, 2);
    v_line_tax   := round(v_line.line_tax * v_qty / v_line.quantity, 2);
    v_line_sub   := v_line_total - v_line_tax;

    v_restock := coalesce((v_item ->> 'restock')::boolean, true);
    if coalesce(v_is_service, false) then
      v_restock := false;
    end if;

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
    v_subtotal, v_tax_total, v_total,
    -- Always the signed-in account (0039) — never p_cashier_id.
    auth.uid(), auth.uid()
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
      -- Always the signed-in account now (0039), same as the row itself.
      'cashier_id', auth.uid()
    )
  );

  -- NEW in 0049: the audit trail this function never had (Gap #2).
  perform log_audit_event(
    v_sale.business_id, v_sale.branch_id, 'sale.refunded', 'refund', v_refund_id,
    jsonb_build_object(
      'sale_id', p_sale_id,
      'receipt_number', v_sale.receipt_number,
      'refund_number', v_reference,
      'total', v_total,
      'reason', nullif(p_reason, '')
    )
  );

  return v_refund_id;
end;
$$;

grant execute on function create_refund(uuid, uuid, text, text, jsonb) to authenticated;

comment on function create_refund(uuid, uuid, text, text, jsonb) is
  'Prices and records a return against a completed sale: apportioned totals, stock back for restocked lines, an account credit if paid on account, a refund_created notification, and (0049) a sale.refunded audit_logs row — in one transaction. Never re-derives a price: every figure is carried from the sale line it is returning. cashier_id is always the signed-in account (0039) — p_cashier_id may only be null or your own id. A service line is never restocked, regardless of the caller''s restock flag (0040) — there is nothing to put back on a shelf.';

-- ── void_expense(): now also writes an audit_logs row ─────────────────────
--
-- Reproduced in full from 0031's current live body, unchanged except for
-- the log_audit_event() call added right before the end.

create or replace function void_expense(p_expense_id uuid, p_reason text)
returns void
language plpgsql
as $$
declare v_expense record;
begin
  if char_length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Say why this expense is being voided' using errcode = 'P0001';
  end if;

  -- Read under the caller's own RLS: an expense they cannot see is an
  -- expense they cannot void, and it reads as "not found" rather than
  -- confirming that a row with that id exists somewhere.
  select * into v_expense from expenses where id = p_expense_id;
  if v_expense.id is null then
    raise exception 'Expense not found' using errcode = 'P0002';
  end if;
  if v_expense.status = 'voided' then
    raise exception 'This expense has already been voided' using errcode = 'P0001';
  end if;

  update expenses
  set status = 'voided',
      voided_by = auth.uid(),
      voided_at = now(),
      void_reason = trim(p_reason)
  where id = p_expense_id and status = 'recorded';

  -- An RLS-denied UPDATE does not raise; it matches nothing. Without
  -- this check the function would return quietly and the caller would
  -- believe the expense was voided.
  if not found then
    raise exception 'Missing permission: expenses.approve' using errcode = '42501';
  end if;

  -- NEW in 0049: the audit trail this function never had (Gap #5).
  perform log_audit_event(
    v_expense.business_id, v_expense.branch_id, 'expense.voided', 'expense', p_expense_id,
    jsonb_build_object(
      'reference_number', v_expense.reference_number,
      'amount', v_expense.amount,
      'reason', trim(p_reason)
    )
  );
end;
$$;

grant execute on function void_expense(uuid, text) to authenticated;

comment on function void_expense(uuid, text) is
  'Voids a recorded expense with a reason, so it stops counting against profit but stays on the page, and (0049) writes an expense.voided audit_logs row. Raises rather than returning quietly if RLS refused the update.';