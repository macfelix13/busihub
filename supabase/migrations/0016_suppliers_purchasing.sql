-- Busihub — 0016: suppliers & purchasing (Phase 7)
--
-- Closes the loop with Phase 6: instead of typing stock in by hand, you
-- raise a purchase order against a supplier, someone approves it, and
-- receiving against it writes the inventory_movements rows automatically
-- — with reference_type/reference_id pointing back at the PO, so every
-- unit of stock that arrived this way is traceable to a supplier, a
-- price, and an authorisation.
--
-- Scope agreed before building: suppliers + purchase orders, approval
-- required before receiving, partial deliveries allowed.
--
-- Permission model (all four already in the 0010 catalog, already
-- assigned in 0011 — no catalog change here):
--   suppliers.view          — read suppliers, purchase orders, and their
--                             lines. There is no purchase_orders.view in
--                             the catalog, and rather than invent one
--                             mid-project, this is the read gate for the
--                             whole purchasing area. Every role that has
--                             any purchasing business has it.
--   suppliers.manage        — create/edit/archive a supplier.
--   purchase_orders.create  — raise a PO and edit it while it is a draft.
--   purchase_orders.approve — approve a draft (and cancel a PO).
--   inventory.receive       — record goods actually arriving. Deliberately
--                             the SAME permission as manual receiving in
--                             0015: whether stock came in via a PO or by
--                             hand, "stock arrived" is one privilege.
--
-- NOTE on separation of duties: the seeded Inventory Manager role (0011)
-- holds purchase_orders.create AND purchase_orders.approve, so a single
-- Inventory Manager can raise and approve their own order. That is a role
-- composition choice, not a hole in the enforcement below — the approve
-- gate is real and checked in the database. Self-approval is deliberately
-- NOT blocked outright, because the common case in this market is a
-- one-person shop where the Owner is necessarily both parties; a business
-- that wants a genuine second pair of eyes removes purchase_orders.approve
-- from whoever raises orders.

-- ── suppliers ────────────────────────────────────────────────────────────

create table suppliers (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  name          text not null check (char_length(trim(name)) > 0),
  contact_name  text,
  phone         text,
  email         citext,
  address       text,
  payment_terms text,
  notes         text,
  status        text not null default 'active' check (status in ('active', 'archived')),
  created_by    uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (business_id, name)
);

create index suppliers_business_id_idx on suppliers (business_id);

create trigger set_updated_at
  before update on suppliers
  for each row execute function set_updated_at();

comment on table suppliers is 'Who a business buys from. Archived rather than deleted — a purchase order must still resolve its supplier years later.';

-- ── purchase orders ──────────────────────────────────────────────────────

create table purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  supplier_id   uuid not null references suppliers(id) on delete restrict,
  -- Where the goods are going. Fixed at creation because the inventory
  -- movements produced by receiving must land somewhere specific.
  branch_id     uuid not null references branches(id) on delete restrict,
  reference     text not null check (char_length(trim(reference)) > 0),
  status        text not null default 'draft' check (status in (
                  'draft', 'approved', 'partially_received', 'received', 'cancelled'
                )),
  expected_date date,
  notes         text,
  created_by    uuid references profiles(id) on delete set null,
  approved_by   uuid references profiles(id) on delete set null,
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (business_id, reference)
);

create index purchase_orders_business_status_idx on purchase_orders (business_id, status);
create index purchase_orders_supplier_idx on purchase_orders (supplier_id);
create index purchase_orders_branch_idx on purchase_orders (branch_id);

create trigger set_updated_at
  before update on purchase_orders
  for each row execute function set_updated_at();

comment on table purchase_orders is
  'An order raised against a supplier. Lifecycle: draft -> approved -> partially_received -> received, with cancelled reachable from any non-terminal state. Only approved/partially_received orders can be received against.';

create table purchase_order_items (
  id                uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  -- Denormalized from the parent by the trigger below so RLS can scope
  -- this table directly — same rationale as product_variants (0013).
  business_id       uuid not null references businesses(id) on delete cascade,
  variant_id        uuid not null references product_variants(id) on delete restrict,
  quantity_ordered  numeric(14, 3) not null check (quantity_ordered > 0),
  quantity_received numeric(14, 3) not null default 0 check (quantity_received >= 0),
  unit_cost         numeric(14, 2) not null default 0 check (unit_cost >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (purchase_order_id, variant_id),
  -- Over-receiving is rejected rather than absorbed. If more physically
  -- arrives than was ordered, that is a conversation with the supplier —
  -- and the stock can still be brought on with a manual receipt (0015),
  -- which records it as exactly that rather than pretending the PO said so.
  constraint purchase_order_items_not_over_received check (quantity_received <= quantity_ordered)
);

create index purchase_order_items_po_idx on purchase_order_items (purchase_order_id);
create index purchase_order_items_variant_idx on purchase_order_items (variant_id);

create trigger set_updated_at
  before update on purchase_order_items
  for each row execute function set_updated_at();

comment on table purchase_order_items is
  'One line of a purchase order. quantity_received accumulates across partial deliveries and can never exceed quantity_ordered (see the check constraint).';

-- ── tenancy forcing ──────────────────────────────────────────────────────

create or replace function set_purchase_order_context()
returns trigger
language plpgsql
as $$
declare
  v_supplier_business uuid;
  v_branch_business   uuid;
begin
  select business_id into v_supplier_business from suppliers where id = new.supplier_id;
  if v_supplier_business is null then
    raise exception 'Invalid supplier_id: supplier not found' using errcode = 'P0002';
  end if;

  select business_id into v_branch_business from branches where id = new.branch_id;
  if v_branch_business is null then
    raise exception 'Invalid branch_id: branch not found' using errcode = 'P0002';
  end if;

  if v_supplier_business <> v_branch_business then
    raise exception 'Supplier and branch belong to different businesses' using errcode = 'P0001';
  end if;

  new.business_id := v_supplier_business;
  new.created_by := auth.uid();
  -- Approval is never set at insert time; it is earned via
  -- approve_purchase_order().
  new.approved_by := null;
  new.approved_at := null;
  new.status := 'draft';

  return new;
end;
$$;

comment on function set_purchase_order_context() is
  'Forces business_id from the supplier (requiring the branch to match), stamps created_by from the session, and pins a new order to draft/unapproved regardless of what the caller sent.';

create trigger set_po_context
  before insert on purchase_orders
  for each row execute function set_purchase_order_context();

create or replace function set_purchase_order_item_context()
returns trigger
language plpgsql
as $$
declare
  v_po_business      uuid;
  v_po_status        text;
  v_variant_business uuid;
begin
  select business_id, status into v_po_business, v_po_status
  from purchase_orders where id = new.purchase_order_id;

  if v_po_business is null then
    raise exception 'Invalid purchase_order_id: order not found' using errcode = 'P0002';
  end if;

  select business_id into v_variant_business from product_variants where id = new.variant_id;
  if v_variant_business is null then
    raise exception 'Invalid variant_id: product variant not found' using errcode = 'P0002';
  end if;

  if v_po_business <> v_variant_business then
    raise exception 'Product and purchase order belong to different businesses' using errcode = 'P0001';
  end if;

  -- Lines can only be added while the order is still a draft; once it is
  -- approved, what was authorised is fixed.
  if v_po_status <> 'draft' then
    raise exception 'This purchase order is no longer a draft and cannot be changed'
      using errcode = 'P0001';
  end if;

  new.business_id := v_po_business;
  -- Receipts are recorded by receive_purchase_order(), never asserted at
  -- insert time.
  new.quantity_received := 0;

  return new;
end;
$$;

create trigger set_po_item_context
  before insert on purchase_order_items
  for each row execute function set_purchase_order_item_context();

-- ── status / immutability enforcement ────────────────────────────────────
--
-- Same reasoning as the enforce_*_field_permissions triggers in 0013: RLS
-- is row-level and cannot see WHICH columns an UPDATE touched, so the
-- rules that actually matter here — who may approve, and what may still
-- change once approved — are enforced column-by-column, in the database,
-- so a request that bypasses the Server Actions entirely still obeys them.

create or replace function enforce_purchase_order_rules()
returns trigger
language plpgsql
as $$
declare
  v_allowed_next text[];
begin
  if new.status is distinct from old.status then
    -- Legal transitions. Anything not listed is rejected outright, so a
    -- crafted update can't jump a cancelled order back to approved or
    -- mark an unapproved draft as received.
    v_allowed_next := case old.status
      when 'draft'              then array['approved', 'cancelled']
      when 'approved'           then array['partially_received', 'received', 'cancelled']
      when 'partially_received' then array['partially_received', 'received', 'cancelled']
      else array[]::text[]
    end;

    if not (new.status = any (v_allowed_next)) then
      raise exception 'Cannot move a purchase order from % to %', old.status, new.status
        using errcode = 'P0001';
    end if;

    if new.status = 'approved'
       and not (app_has_permission(new.business_id, 'purchase_orders.approve') or app_is_super_admin()) then
      raise exception 'Missing permission: purchase_orders.approve' using errcode = '42501';
    end if;

    if new.status = 'cancelled'
       and not (app_has_permission(new.business_id, 'purchase_orders.approve') or app_is_super_admin()) then
      raise exception 'Missing permission: purchase_orders.approve' using errcode = '42501';
    end if;

    -- Receiving states are reached by recording goods in, which is the
    -- inventory privilege, not a purchasing one.
    if new.status in ('partially_received', 'received')
       and not (app_has_permission(new.business_id, 'inventory.receive') or app_is_super_admin()) then
      raise exception 'Missing permission: inventory.receive' using errcode = '42501';
    end if;
  end if;

  -- Everything else about an order is frozen once it leaves draft: the
  -- whole point of approving a document is that it stops changing.
  if old.status <> 'draft' and (
       new.supplier_id is distinct from old.supplier_id
    or new.branch_id is distinct from old.branch_id
    or new.reference is distinct from old.reference
    or new.expected_date is distinct from old.expected_date
  ) then
    raise exception 'An approved purchase order can no longer be edited' using errcode = 'P0001';
  end if;

  if old.status = 'draft' and (
       new.supplier_id is distinct from old.supplier_id
    or new.branch_id is distinct from old.branch_id
    or new.reference is distinct from old.reference
    or new.expected_date is distinct from old.expected_date
    or new.notes is distinct from old.notes
  ) and not (app_has_permission(new.business_id, 'purchase_orders.create') or app_is_super_admin()) then
    raise exception 'Missing permission: purchase_orders.create' using errcode = '42501';
  end if;

  -- created_by is history, not a field.
  if new.created_by is distinct from old.created_by then
    raise exception 'created_by cannot be changed' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function enforce_purchase_order_rules() is
  'BEFORE UPDATE: validates the status machine, requires purchase_orders.approve to approve/cancel and inventory.receive to move into a received state, and freezes the order''s terms once it leaves draft.';

create trigger enforce_po_rules
  before update on purchase_orders
  for each row execute function enforce_purchase_order_rules();

create or replace function enforce_purchase_order_item_rules()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  select status into v_status from purchase_orders where id = new.purchase_order_id;

  if new.quantity_received is distinct from old.quantity_received then
    if new.quantity_received < old.quantity_received then
      raise exception 'Received quantity cannot be reduced' using errcode = 'P0001';
    end if;
    if not (app_has_permission(new.business_id, 'inventory.receive') or app_is_super_admin()) then
      raise exception 'Missing permission: inventory.receive' using errcode = '42501';
    end if;
    if v_status not in ('approved', 'partially_received') then
      raise exception 'This purchase order is not approved for receiving' using errcode = 'P0001';
    end if;
  end if;

  if (
       new.variant_id is distinct from old.variant_id
    or new.quantity_ordered is distinct from old.quantity_ordered
    or new.unit_cost is distinct from old.unit_cost
  ) then
    if v_status <> 'draft' then
      raise exception 'An approved purchase order can no longer be edited' using errcode = 'P0001';
    end if;
    if not (app_has_permission(new.business_id, 'purchase_orders.create') or app_is_super_admin()) then
      raise exception 'Missing permission: purchase_orders.create' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create trigger enforce_po_item_rules
  before update on purchase_order_items
  for each row execute function enforce_purchase_order_item_rules();

-- Deleting a line is only meaningful while drafting.
create or replace function enforce_purchase_order_item_delete()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  select status into v_status from purchase_orders where id = old.purchase_order_id;
  -- v_status is null when the parent order is itself being deleted
  -- (ON DELETE CASCADE); that is not a line edit and is allowed through.
  if v_status is not null and v_status <> 'draft' then
    raise exception 'An approved purchase order can no longer be edited' using errcode = 'P0001';
  end if;
  return old;
end;
$$;

create trigger enforce_po_item_delete
  before delete on purchase_order_items
  for each row execute function enforce_purchase_order_item_delete();

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table suppliers enable row level security;

create policy suppliers_select on suppliers
  for select
  using (app_has_permission(business_id, 'suppliers.view') or app_is_super_admin());

create policy suppliers_insert on suppliers
  for insert
  with check (app_has_permission(business_id, 'suppliers.manage') or app_is_super_admin());

create policy suppliers_update on suppliers
  for update
  using (app_has_permission(business_id, 'suppliers.manage') or app_is_super_admin())
  with check (app_has_permission(business_id, 'suppliers.manage') or app_is_super_admin());

-- No delete policy: archive instead (a PO must still resolve its supplier).

alter table purchase_orders enable row level security;

create policy purchase_orders_select on purchase_orders
  for select
  using (app_has_permission(business_id, 'suppliers.view') or app_is_super_admin());

create policy purchase_orders_insert on purchase_orders
  for insert
  with check (app_has_permission(business_id, 'purchase_orders.create') or app_is_super_admin());

-- Coarse row-level gate; which column may move, and by whom, is settled
-- by enforce_purchase_order_rules() above.
create policy purchase_orders_update on purchase_orders
  for update
  using (
    app_has_permission(business_id, 'purchase_orders.create')
    or app_has_permission(business_id, 'purchase_orders.approve')
    or app_has_permission(business_id, 'inventory.receive')
    or app_is_super_admin()
  )
  with check (
    app_has_permission(business_id, 'purchase_orders.create')
    or app_has_permission(business_id, 'purchase_orders.approve')
    or app_has_permission(business_id, 'inventory.receive')
    or app_is_super_admin()
  );

alter table purchase_order_items enable row level security;

create policy purchase_order_items_select on purchase_order_items
  for select
  using (app_has_permission(business_id, 'suppliers.view') or app_is_super_admin());

create policy purchase_order_items_insert on purchase_order_items
  for insert
  with check (app_has_permission(business_id, 'purchase_orders.create') or app_is_super_admin());

create policy purchase_order_items_update on purchase_order_items
  for update
  using (
    app_has_permission(business_id, 'purchase_orders.create')
    or app_has_permission(business_id, 'inventory.receive')
    or app_is_super_admin()
  )
  with check (
    app_has_permission(business_id, 'purchase_orders.create')
    or app_has_permission(business_id, 'inventory.receive')
    or app_is_super_admin()
  );

create policy purchase_order_items_delete on purchase_order_items
  for delete
  using (app_has_permission(business_id, 'purchase_orders.create') or app_is_super_admin());

-- ── create_purchase_order(): atomic order + lines, with a reference ──────
--
-- One transaction, same rationale as create_product (0013): an order with
-- no lines is a meaningless document, so either the whole thing lands or
-- none of it does. SECURITY INVOKER, so the RLS policies above apply to
-- its inserts exactly as if the caller ran them.
--
-- The reference is generated here rather than typed by the user, under an
-- advisory lock on the business so two people raising an order at the same
-- moment cannot both claim PO-0007 (the unique constraint would catch it,
-- but as a failed save rather than as two correct numbers).
create or replace function create_purchase_order(
  p_supplier_id uuid,
  p_branch_id uuid,
  p_expected_date date,
  p_notes text,
  p_items jsonb -- [{variant_id, quantity_ordered, unit_cost}]
)
returns uuid
language plpgsql
as $$
declare
  v_business_id uuid;
  v_po_id       uuid;
  v_item        jsonb;
  v_next        int;
  v_reference   text;
begin
  if p_items is null or jsonb_array_length(p_items) < 1 then
    raise exception 'A purchase order needs at least one line' using errcode = 'P0001';
  end if;

  select business_id into v_business_id from suppliers where id = p_supplier_id;
  if v_business_id is null then
    raise exception 'Invalid supplier_id: supplier not found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('po_reference:' || v_business_id::text, 0));

  select coalesce(max((substring(reference from '^PO-([0-9]+)$'))::int), 0) + 1
  into v_next
  from purchase_orders
  where business_id = v_business_id and reference ~ '^PO-[0-9]+$';

  v_reference := 'PO-' || lpad(v_next::text, 4, '0');

  insert into purchase_orders (business_id, supplier_id, branch_id, reference, expected_date, notes)
  values (v_business_id, p_supplier_id, p_branch_id, v_reference, p_expected_date, nullif(p_notes, ''))
  returning id into v_po_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into purchase_order_items (
      purchase_order_id, business_id, variant_id, quantity_ordered, unit_cost
    )
    values (
      v_po_id, v_business_id,
      (v_item ->> 'variant_id')::uuid,
      (v_item ->> 'quantity_ordered')::numeric,
      coalesce((v_item ->> 'unit_cost')::numeric, 0)
    );
  end loop;

  return v_po_id;
end;
$$;

grant execute on function create_purchase_order(uuid, uuid, date, text, jsonb) to authenticated;

comment on function create_purchase_order(uuid, uuid, date, text, jsonb) is
  'Atomically creates a draft purchase order and its lines, generating the next PO-NNNN reference for the business under an advisory lock.';

-- ── approve / cancel ─────────────────────────────────────────────────────

create or replace function approve_purchase_order(p_purchase_order_id uuid)
returns void
language plpgsql
as $$
begin
  -- The permission check and the legal-transition check both live in
  -- enforce_purchase_order_rules(); this function exists so the app has a
  -- single call to make and so approved_by/approved_at are stamped from
  -- the session rather than supplied.
  update purchase_orders
  set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = p_purchase_order_id;

  if not found then
    raise exception 'Purchase order not found' using errcode = 'P0002';
  end if;
end;
$$;

grant execute on function approve_purchase_order(uuid) to authenticated;

create or replace function cancel_purchase_order(p_purchase_order_id uuid)
returns void
language plpgsql
as $$
begin
  update purchase_orders set status = 'cancelled' where id = p_purchase_order_id;

  if not found then
    raise exception 'Purchase order not found' using errcode = 'P0002';
  end if;
end;
$$;

grant execute on function cancel_purchase_order(uuid) to authenticated;

-- ── receive_purchase_order(): the loop back into inventory ───────────────
--
-- Takes [{item_id, quantity}] and, in ONE transaction: bumps each line's
-- quantity_received, writes the matching inventory_movements row (which
-- is what actually moves stock, via 0015's trigger), and recomputes the
-- order's status. Lines with a zero/absent quantity are skipped, so the
-- receiving form can submit every line and let the user fill in only what
-- turned up.
--
-- SECURITY INVOKER on purpose: the caller needs inventory.receive for the
-- movement insert to pass 0015's RLS policy, and that is exactly the
-- check we want — receiving against a PO is not a way to move stock
-- without the stock-receiving privilege.
create or replace function receive_purchase_order(
  p_purchase_order_id uuid,
  p_receipts jsonb, -- [{item_id, quantity}]
  p_note text default null
)
returns text -- the order's status after receiving
language plpgsql
as $$
declare
  v_po        purchase_orders%rowtype;
  v_receipt   jsonb;
  v_item      purchase_order_items%rowtype;
  v_qty       numeric(14, 3);
  v_any       boolean := false;
  v_outstanding boolean;
  v_status    text;
begin
  select * into v_po from purchase_orders where id = p_purchase_order_id for update;

  if not found then
    raise exception 'Purchase order not found' using errcode = 'P0002';
  end if;

  if v_po.status not in ('approved', 'partially_received') then
    raise exception 'This purchase order is not approved for receiving' using errcode = 'P0001';
  end if;

  if p_receipts is null or jsonb_array_length(p_receipts) < 1 then
    raise exception 'Nothing to receive' using errcode = 'P0001';
  end if;

  for v_receipt in select * from jsonb_array_elements(p_receipts)
  loop
    v_qty := coalesce((v_receipt ->> 'quantity')::numeric, 0);

    if v_qty > 0 then
      select * into v_item
      from purchase_order_items
      where id = (v_receipt ->> 'item_id')::uuid
        and purchase_order_id = p_purchase_order_id
      for update;

      if not found then
        raise exception 'That line is not part of this purchase order' using errcode = 'P0002';
      end if;

      -- The not-over-received check constraint is what actually stops a
      -- receipt exceeding what was ordered; it raises 23514, which the
      -- Server Action turns into a readable message.
      update purchase_order_items
      set quantity_received = quantity_received + v_qty
      where id = v_item.id;

      insert into inventory_movements (
        business_id, branch_id, variant_id, quantity_delta, reason,
        reference_type, reference_id, note
      )
      values (
        -- Overwritten by set_inventory_movement_context() (0015); a
        -- non-null placeholder only satisfies NOT NULL until it runs.
        '00000000-0000-0000-0000-000000000000',
        v_po.branch_id, v_item.variant_id, v_qty, 'receive',
        'purchase_order', p_purchase_order_id,
        coalesce(nullif(p_note, ''), 'Received against ' || v_po.reference)
      );

      v_any := true;
    end if;
  end loop;

  if not v_any then
    raise exception 'Nothing to receive' using errcode = 'P0001';
  end if;

  select exists (
    select 1 from purchase_order_items
    where purchase_order_id = p_purchase_order_id
      and quantity_received < quantity_ordered
  ) into v_outstanding;

  v_status := case when v_outstanding then 'partially_received' else 'received' end;

  update purchase_orders set status = v_status where id = p_purchase_order_id;

  return v_status;
end;
$$;

grant execute on function receive_purchase_order(uuid, jsonb, text) to authenticated;

comment on function receive_purchase_order(uuid, jsonb, text) is
  'Records a (possibly partial) delivery against an approved purchase order: bumps each line''s received quantity, writes the inventory movements that actually move the stock, and recomputes the order status — all in one transaction.';
