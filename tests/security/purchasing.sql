-- Busihub — security/behaviour test for suppliers & purchasing
-- (migration 0016), exercised directly against Postgres + RLS rather than
-- through the application.
--
-- Run against a throwaway Postgres loaded with
-- tests/db-harness/00_stub_supabase.sql + supabase/migrations/*.sql +
-- supabase/seed.sql (see tests/security/README.md).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────
-- Business A is the seeded demo store. We add a second business, a
-- Cashier (no purchasing permissions at all) and an "Approver-less" user
-- holding purchase_orders.create + inventory.receive but NOT
-- purchase_orders.approve — the interesting case for the approval gate.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000043',
   'authenticated', 'authenticated', 'ownerc@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000098',
   'authenticated', 'authenticated', 'buyer@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000099',
   'authenticated', 'authenticated', 'cashier@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000043';
select register_business('Purchasing Test Shop C', 'Yaa', 'Asante');
reset role;
reset request.jwt.claim.sub;

-- A product in business A to actually order.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select create_product(
  (select id from businesses where slug = 'busihub-demo-store'),
  'Test Sugar 1kg', null, 'Grocery', 'kg', 'standard',
  '{}'::text[],
  '[{"sku": "SUGAR-1KG", "barcode": "", "variant_options": {}, "cost_price": 8, "selling_price": 12}]'::jsonb
);
reset role;
reset request.jwt.claim.sub;

create table p_ids as
select
  (select id from businesses where slug = 'busihub-demo-store')            as biz_a,
  (select id from businesses where slug = 'purchasing-test-shop-c')        as biz_c,
  (select b.id from branches b
     where b.business_id = (select id from businesses where slug = 'busihub-demo-store')
       and b.is_main)                                                      as branch_a,
  (select b.id from branches b
     where b.business_id = (select id from businesses where slug = 'purchasing-test-shop-c')
       and b.is_main)                                                      as branch_c,
  (select v.id from product_variants v where v.sku = 'SUGAR-1KG')          as variant_a;

do $$
declare r record;
begin
  select * into r from p_ids;
  if r.biz_a is null or r.biz_c is null or r.branch_a is null or r.branch_c is null or r.variant_a is null then
    raise exception 'TEST FIXTURE BROKEN: p_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

grant select on p_ids to authenticated;

-- A "Buyer" role: can raise orders and receive goods, but cannot approve.
do $$
declare
  v_biz uuid; v_branch uuid; v_role uuid;
begin
  select biz_a, branch_a into v_biz, v_branch from p_ids;

  insert into roles (business_id, name, description, is_system_role)
    values (v_biz, 'Test Buyer', 'Raises and receives, cannot approve.', false)
    returning id into v_role;

  insert into role_permissions (role_id, permission_id)
    select v_role, id from permissions
    where key in ('suppliers.view', 'suppliers.manage', 'purchase_orders.create',
                  'inventory.view', 'inventory.receive', 'products.view');

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000098', v_biz, 'Test', 'Buyer', 'buyer@busihub.dev.example')
    on conflict (id) do nothing;
  insert into profiles (id, business_id, first_name, last_name, email)
    values ('00000000-0000-0000-0000-000000000099', v_biz, 'Demo', 'Cashier', 'cashier@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000000098', v_role,
            '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_biz, v_branch, '00000000-0000-0000-0000-000000000099',
            (select id from roles where business_id = v_biz and name = 'Cashier'),
            '00000000-0000-0000-0000-000000000001')
    on conflict do nothing;
end $$;

-- ── 1. Supplier + PO creation, and the generated reference ───────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare v_supplier uuid; v_po uuid; v_ref text; v_status text; v_lines int;
begin
  insert into suppliers (business_id, name, phone, email)
  select biz_a, 'Accra Wholesale Ltd', '+233200000001', 'sales@accrawholesale.example' from p_ids
  returning id into v_supplier;

  select create_purchase_order(
    v_supplier, (select branch_a from p_ids), current_date + 7, 'First order',
    jsonb_build_array(jsonb_build_object(
      'variant_id', (select variant_a from p_ids), 'quantity_ordered', 10, 'unit_cost', 8
    ))
  ) into v_po;

  select reference, status into v_ref, v_status from purchase_orders where id = v_po;
  select count(*) into v_lines from purchase_order_items where purchase_order_id = v_po;

  if v_ref <> 'PO-0001' then
    raise exception 'TEST FAILED: expected reference PO-0001, got %', v_ref using errcode = 'ZZ999';
  end if;
  if v_status <> 'draft' then
    raise exception 'TEST FAILED: a new order should be a draft, got %', v_status using errcode = 'ZZ999';
  end if;
  if v_lines <> 1 then
    raise exception 'TEST FAILED: expected 1 line, got %', v_lines using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: supplier + PO created, reference generated (%), starts as draft', v_ref;
end $$;

-- ── 2. A new order cannot claim to be pre-approved ───────────────────────

do $$
declare v_po uuid; v_status text; v_by uuid;
begin
  insert into purchase_orders (business_id, supplier_id, branch_id, reference, status, approved_by, approved_at)
  select biz_a, (select id from suppliers limit 1), branch_a, 'PO-SPOOF', 'approved',
         '00000000-0000-0000-0000-000000000001', now()
  from p_ids
  returning id, status, approved_by into v_po, v_status, v_by;

  if v_status <> 'draft' then
    raise exception 'TEST FAILED: an order inserted as "approved" stayed approved (%)', v_status using errcode = 'ZZ999';
  end if;
  if v_by is not null then
    raise exception 'TEST FAILED: spoofed approved_by survived' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: an order claiming to be pre-approved is forced back to draft';
  delete from purchase_orders where id = v_po;
end $$;

-- ── 3. A draft cannot be received against ────────────────────────────────

do $$
declare v_po uuid; v_item uuid;
begin
  select id into v_po from purchase_orders where reference = 'PO-0001';
  select id into v_item from purchase_order_items where purchase_order_id = v_po;

  begin
    perform receive_purchase_order(v_po, jsonb_build_array(
      jsonb_build_object('item_id', v_item, 'quantity', 5)));
    raise exception 'TEST FAILED: received goods against an unapproved draft' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: receiving against a draft rejected (%)', sqlerrm;
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 4. The approval gate is real ─────────────────────────────────────────
-- The Buyer has purchase_orders.create and inventory.receive, but NOT
-- purchase_orders.approve.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000098';

do $$
declare v_po uuid;
begin
  select id into v_po from purchase_orders where reference = 'PO-0001';

  begin
    perform approve_purchase_order(v_po);
    raise exception 'TEST FAILED: a user without purchase_orders.approve approved an order' using errcode = 'ZZ999';
  exception
    when insufficient_privilege then
      raise notice 'PASS: approval blocked without purchase_orders.approve';
  end;

  -- ...and not by a raw UPDATE either.
  begin
    update purchase_orders set status = 'approved' where id = v_po;
    raise exception 'TEST FAILED: raw UPDATE bypassed the approval permission' using errcode = 'ZZ999';
  exception
    when insufficient_privilege then
      raise notice 'PASS: raw UPDATE to approved also blocked';
  end;

  -- Nor by jumping straight to received.
  begin
    update purchase_orders set status = 'received' where id = v_po;
    raise exception 'TEST FAILED: a draft was moved straight to received' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: illegal transition draft -> received rejected';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 5. Cashier has no purchasing access at all ───────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000099';

do $$
declare v_seen int;
begin
  select count(*) into v_seen from suppliers;
  if v_seen <> 0 then
    raise exception 'TEST FAILED: cashier (no suppliers.view) saw % suppliers', v_seen using errcode = 'ZZ999';
  end if;

  select count(*) into v_seen from purchase_orders;
  if v_seen <> 0 then
    raise exception 'TEST FAILED: cashier saw % purchase orders', v_seen using errcode = 'ZZ999';
  end if;

  begin
    insert into suppliers (business_id, name) select biz_a, 'Sneaky Supplier' from p_ids;
    raise exception 'TEST FAILED: cashier created a supplier' using errcode = 'ZZ999';
  exception
    when insufficient_privilege then
      raise notice 'PASS: cashier blocked from creating a supplier';
  end;

  raise notice 'PASS: cashier sees no suppliers or purchase orders';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 6. Approve, then partial receipt ─────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

do $$
declare
  v_po uuid; v_item uuid; v_status text; v_received numeric; v_stock numeric;
  v_branch uuid; v_variant uuid; v_approver uuid;
begin
  select branch_a, variant_a into v_branch, v_variant from p_ids;
  select id into v_po from purchase_orders where reference = 'PO-0001';
  select id into v_item from purchase_order_items where purchase_order_id = v_po;

  perform approve_purchase_order(v_po);

  select status, approved_by into v_status, v_approver from purchase_orders where id = v_po;
  if v_status <> 'approved' then
    raise exception 'TEST FAILED: order not approved, status is %', v_status using errcode = 'ZZ999';
  end if;
  if v_approver <> '00000000-0000-0000-0000-000000000001' then
    raise exception 'TEST FAILED: approved_by not stamped from the session' using errcode = 'ZZ999';
  end if;

  -- 4 of 10 arrive.
  select receive_purchase_order(v_po, jsonb_build_array(
    jsonb_build_object('item_id', v_item, 'quantity', 4)), null) into v_status;

  if v_status <> 'partially_received' then
    raise exception 'TEST FAILED: expected partially_received, got %', v_status using errcode = 'ZZ999';
  end if;

  select quantity_received into v_received from purchase_order_items where id = v_item;
  if v_received <> 4 then
    raise exception 'TEST FAILED: expected 4 received, got %', v_received using errcode = 'ZZ999';
  end if;

  -- The whole point: stock actually moved.
  select quantity into v_stock from stock_levels
  where branch_id = v_branch and variant_id = v_variant;
  if v_stock is distinct from 4 then
    raise exception 'TEST FAILED: expected 4 in stock after receiving, got %', v_stock using errcode = 'ZZ999';
  end if;

  -- ...and it is traceable back to the order.
  if not exists (
    select 1 from inventory_movements
    where reference_type = 'purchase_order' and reference_id = v_po and quantity_delta = 4
  ) then
    raise exception 'TEST FAILED: the movement is not linked back to the purchase order' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: approve -> partial receipt of 4/10, stock moved and linked to the PO';
end $$;

-- ── 7. Over-receiving is refused ─────────────────────────────────────────

do $$
declare v_po uuid; v_item uuid; v_received numeric; v_stock numeric; v_branch uuid; v_variant uuid;
begin
  select branch_a, variant_a into v_branch, v_variant from p_ids;
  select id into v_po from purchase_orders where reference = 'PO-0001';
  select id into v_item from purchase_order_items where purchase_order_id = v_po;

  begin
    -- 4 already in, ordered 10 — 7 more would be 11.
    perform receive_purchase_order(v_po, jsonb_build_array(
      jsonb_build_object('item_id', v_item, 'quantity', 7)), null);
    raise exception 'TEST FAILED: received more than was ordered' using errcode = 'ZZ999';
  exception
    when check_violation then
      raise notice 'PASS: over-receipt rejected by the not-over-received constraint';
  end;

  select quantity_received into v_received from purchase_order_items where id = v_item;
  select quantity into v_stock from stock_levels where branch_id = v_branch and variant_id = v_variant;

  if v_received <> 4 then
    raise exception 'TEST FAILED: rejected over-receipt still changed quantity_received (%)', v_received using errcode = 'ZZ999';
  end if;
  if v_stock is distinct from 4 then
    raise exception 'TEST FAILED: rejected over-receipt still moved stock (now %)', v_stock using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: the rejected over-receipt rolled back both the line and the stock';
end $$;

-- ── 8. Completing the delivery closes the order ──────────────────────────

do $$
declare v_po uuid; v_item uuid; v_status text; v_stock numeric; v_branch uuid; v_variant uuid;
begin
  select branch_a, variant_a into v_branch, v_variant from p_ids;
  select id into v_po from purchase_orders where reference = 'PO-0001';
  select id into v_item from purchase_order_items where purchase_order_id = v_po;

  select receive_purchase_order(v_po, jsonb_build_array(
    jsonb_build_object('item_id', v_item, 'quantity', 6)), null) into v_status;

  if v_status <> 'received' then
    raise exception 'TEST FAILED: expected received once complete, got %', v_status using errcode = 'ZZ999';
  end if;

  select quantity into v_stock from stock_levels where branch_id = v_branch and variant_id = v_variant;
  if v_stock is distinct from 10 then
    raise exception 'TEST FAILED: expected 10 in stock, got %', v_stock using errcode = 'ZZ999';
  end if;

  -- A fully received order is terminal.
  begin
    perform receive_purchase_order(v_po, jsonb_build_array(
      jsonb_build_object('item_id', v_item, 'quantity', 1)), null);
    raise exception 'TEST FAILED: received against an already-complete order' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: a completed order refuses further receipts';
  end;

  raise notice 'PASS: 4 + 6 of 10 closes the order and leaves exactly 10 in stock';
end $$;

-- ── 9. An approved order is frozen ───────────────────────────────────────

do $$
declare v_po uuid; v_item uuid;
begin
  select id into v_po from purchase_orders where reference = 'PO-0001';
  select id into v_item from purchase_order_items where purchase_order_id = v_po;

  begin
    update purchase_orders set expected_date = current_date + 30 where id = v_po;
    raise exception 'TEST FAILED: an approved order was still editable' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: approved order''s terms are frozen';
  end;

  begin
    update purchase_order_items set quantity_ordered = 999 where id = v_item;
    raise exception 'TEST FAILED: an approved order''s line was still editable' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: approved order''s lines are frozen';
  end;

  begin
    delete from purchase_order_items where id = v_item;
    raise exception 'TEST FAILED: a line was deleted from an approved order' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: lines cannot be deleted from an approved order';
  end;

  begin
    update purchase_order_items set quantity_received = 0 where id = v_item;
    raise exception 'TEST FAILED: received quantity was reduced' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: received quantity cannot be walked back';
  end;
end $$;

-- ── 10. Cancelling, and what it forbids ──────────────────────────────────

do $$
declare v_supplier uuid; v_po uuid; v_item uuid; v_status text;
begin
  select id into v_supplier from suppliers limit 1;

  select create_purchase_order(
    v_supplier, (select branch_a from p_ids), null, null,
    jsonb_build_array(jsonb_build_object(
      'variant_id', (select variant_a from p_ids), 'quantity_ordered', 3, 'unit_cost', 8))
  ) into v_po;

  perform cancel_purchase_order(v_po);
  select status into v_status from purchase_orders where id = v_po;
  if v_status <> 'cancelled' then
    raise exception 'TEST FAILED: expected cancelled, got %', v_status using errcode = 'ZZ999';
  end if;

  select id into v_item from purchase_order_items where purchase_order_id = v_po;

  begin
    update purchase_orders set status = 'approved' where id = v_po;
    raise exception 'TEST FAILED: a cancelled order was revived' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: a cancelled order cannot be revived';
  end;

  begin
    perform receive_purchase_order(v_po, jsonb_build_array(
      jsonb_build_object('item_id', v_item, 'quantity', 1)), null);
    raise exception 'TEST FAILED: received against a cancelled order' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: a cancelled order cannot be received against';
  end;

  raise notice 'PASS: cancellation is terminal';
end $$;

-- ── 11. References are per-business and sequential ───────────────────────

do $$
declare v_supplier uuid; v_po uuid; v_ref text;
begin
  select id into v_supplier from suppliers limit 1;
  select create_purchase_order(
    v_supplier, (select branch_a from p_ids), null, null,
    jsonb_build_array(jsonb_build_object(
      'variant_id', (select variant_a from p_ids), 'quantity_ordered', 1, 'unit_cost', 8))
  ) into v_po;

  select reference into v_ref from purchase_orders where id = v_po;
  if v_ref <> 'PO-0003' then
    raise exception 'TEST FAILED: expected PO-0003 (after PO-0001 and PO-0002), got %', v_ref using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: references increment per business (%)', v_ref;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 12. Cross-tenant isolation ───────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000043';

do $$
declare v_seen int; v_supplier_a uuid;
begin
  select count(*) into v_seen from suppliers;
  if v_seen <> 0 then
    raise exception 'TEST FAILED: business C owner saw % of business A''s suppliers', v_seen using errcode = 'ZZ999';
  end if;

  select count(*) into v_seen from purchase_orders;
  if v_seen <> 0 then
    raise exception 'TEST FAILED: business C owner saw % of business A''s orders', v_seen using errcode = 'ZZ999';
  end if;

  -- Business C's own reference numbering must start fresh, not continue
  -- A's — proof the per-business scoping in create_purchase_order works.
  declare
    v_supplier_c uuid; v_po uuid; v_ref text;
  begin
    insert into suppliers (business_id, name)
    select biz_c, 'Kumasi Traders' from p_ids returning id into v_supplier_c;

    select create_purchase_order(
      v_supplier_c, (select branch_c from p_ids), null, null,
      jsonb_build_array(jsonb_build_object(
        'variant_id', (select variant_a from p_ids), 'quantity_ordered', 1, 'unit_cost', 1))
    ) into v_po;

    raise exception 'TEST FAILED: business C ordered business A''s product' using errcode = 'ZZ999';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: cross-tenant product on a PO rejected (business mismatch)';
    when sqlstate 'P0002' then
      raise notice 'PASS: cross-tenant product on a PO rejected (not visible)';
  end;

  raise notice 'PASS: business C sees none of business A''s purchasing data';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 13. The ledger still reconciles after all of the above ───────────────

do $$
declare v_mismatches int;
begin
  select count(*) into v_mismatches
  from stock_levels s
  where s.quantity is distinct from (
    select coalesce(sum(m.quantity_delta), 0)
    from inventory_movements m
    where m.branch_id = s.branch_id and m.variant_id = s.variant_id
  );

  if v_mismatches <> 0 then
    raise exception 'TEST FAILED: % stock level(s) disagree with the movement ledger', v_mismatches using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: stock levels still reconcile to the ledger after PO receiving';
end $$;

\echo ''
\echo 'All purchasing tests passed.'
