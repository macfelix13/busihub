-- Busihub — behaviour/security test for migration 0037.
--
-- Before 0037: any Cashier (sales.process, no reports.view) could read
-- every sale, refund and payment in the whole business, not just their
-- own — the sales.process branch of each SELECT policy carried no
-- restriction on which rows. This file asserts the fix: a Cashier sees
-- only rows tied to their own cashier_id, while reports.view holders
-- (Owner, Manager, ...) keep seeing everything, exactly as before.
--
-- Sale/refund ids are passed between blocks with set_config()/
-- current_setting() rather than a helper table — plain session GUCs,
-- visible for the rest of this file regardless of which role is set.
--
-- `TEST FAILED` raises carry SQLSTATE ZZ999, which no handler here catches.

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures: two Cashiers in the same shop, each PIN-verified for their
-- own sale, plus a custom role that can refund without reports.view ──────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000601',
   'authenticated', 'authenticated', 'covis-cashier-one@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000602',
   'authenticated', 'authenticated', 'covis-cashier-two@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000603',
   'authenticated', 'authenticated', 'covis-refunder@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select create_product(
  (select id from businesses where slug = 'busihub-demo-store'),
  'Visibility Test Item', null, null, 'each', 'standard',
  '{}'::text[],
  '[{"sku": "COVIS-1", "barcode": "", "variant_options": {}, "cost_price": 4, "selling_price": 40}]'::jsonb
);
reset role;
reset request.jwt.claim.sub;

create table cov_ids as
select
  (select id from businesses where slug = 'busihub-demo-store') as biz_a,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'busihub-demo-store') and b.is_main) as branch_a,
  (select id from product_variants where sku = 'COVIS-1') as item;

do $$
declare r record;
begin
  select * into r from cov_ids;
  if r.biz_a is null or r.branch_a is null or r.item is null then
    raise exception 'TEST FIXTURE BROKEN: cov_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

grant select on cov_ids to authenticated;

do $$
declare v_biz uuid; v_branch uuid; v_cashier_role uuid; v_refund_role uuid;
begin
  select biz_a, branch_a into v_biz, v_branch from cov_ids;
  select id into v_cashier_role from roles where business_id = v_biz and name = 'Cashier';

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
  values
    ('00000000-0000-0000-0000-000000000601', v_biz, 'Cash', 'One', 'covis-cashier-one@busihub.dev.example'),
    ('00000000-0000-0000-0000-000000000602', v_biz, 'Cash', 'Two', 'covis-cashier-two@busihub.dev.example'),
    ('00000000-0000-0000-0000-000000000603', v_biz, 'Ref', 'Under', 'covis-refunder@busihub.dev.example')
  on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
  values
    (v_biz, v_branch, '00000000-0000-0000-0000-000000000601', v_cashier_role,
     '00000000-0000-0000-0000-000000000001'),
    (v_biz, v_branch, '00000000-0000-0000-0000-000000000602', v_cashier_role,
     '00000000-0000-0000-0000-000000000001')
  on conflict do nothing;

  -- A role that can process AND refund a sale, but was never given
  -- reports.view — the default seed never produces this (Manager holds
  -- both sales.refund and reports.view), but refunds_select still needs
  -- to be correct for it.
  insert into roles (business_id, name, description, is_system_role)
  values (v_biz, 'Refund-Only Test Role', 'Test fixture: sales.process + sales.refund, no reports.view.', false)
  returning id into v_refund_role;
  insert into role_permissions (role_id, permission_id)
  select v_refund_role, id from permissions where key in ('sales.process', 'sales.refund');

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
  values (v_biz, v_branch, '00000000-0000-0000-0000-000000000603', v_refund_role,
          '00000000-0000-0000-0000-000000000001')
  on conflict do nothing;
end $$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
insert into inventory_movements (branch_id, variant_id, quantity_delta, reason)
select branch_a, item, 100, 'receive' from cov_ids;
reset role;
reset request.jwt.claim.sub;

-- ── 1. Two cashiers each ring up their own sale ──────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000601';
do $$
declare v_sale uuid;
begin
  select create_sale(
    (select branch_a from cov_ids), '00000000-0000-0000-0000-000000000601', null, 'cash', 40,
    jsonb_build_array(jsonb_build_object('variant_id', (select item from cov_ids), 'quantity', 1))
  ) into v_sale;
  perform set_config('covis.sale_1', v_sale::text, false);
  raise notice 'FIXTURE: cashier one rang up sale %', v_sale;
end $$;
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000602';
do $$
declare v_sale uuid;
begin
  select create_sale(
    (select branch_a from cov_ids), '00000000-0000-0000-0000-000000000602', null, 'cash', 40,
    jsonb_build_array(jsonb_build_object('variant_id', (select item from cov_ids), 'quantity', 1))
  ) into v_sale;
  perform set_config('covis.sale_2', v_sale::text, false);
  raise notice 'FIXTURE: cashier two rang up sale %', v_sale;
end $$;
reset role;
reset request.jwt.claim.sub;

-- ── 2. Cashier one sees their own sale, not cashier two's ────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000601';
do $$
declare
  v_sale_1 uuid := current_setting('covis.sale_1')::uuid;
  v_sale_2 uuid := current_setting('covis.sale_2')::uuid;
  v_total int;
  v_own int;
begin
  if not exists (select 1 from sales where id = v_sale_1) then
    raise exception 'TEST FAILED: cashier one cannot see their own sale' using errcode = 'ZZ999';
  end if;
  if exists (select 1 from sales where id = v_sale_2) then
    raise exception 'TEST FAILED: cashier one can see cashier two''s sale' using errcode = 'ZZ999';
  end if;

  -- Every sale this session can see must be theirs — not merely that the
  -- two fixture sales above split the right way, but that nothing else is
  -- leaking through either.
  select count(*) into v_total from sales;
  select count(*) into v_own from sales where cashier_id = '00000000-0000-0000-0000-000000000601';
  if v_total <> v_own then
    raise exception 'TEST FAILED: cashier one can see % sale(s) that are not their own', v_total - v_own
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a cashier sees only their own sales — % of them, all their own', v_total;
end $$;
reset role;
reset request.jwt.claim.sub;

-- ── 3. Same split for sale_items and sale_payments ───────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000601';
do $$
declare
  v_sale_1 uuid := current_setting('covis.sale_1')::uuid;
  v_sale_2 uuid := current_setting('covis.sale_2')::uuid;
begin
  if not exists (select 1 from sale_items where sale_id = v_sale_1) then
    raise exception 'TEST FAILED: cashier one cannot see their own sale''s line items' using errcode = 'ZZ999';
  end if;
  if exists (select 1 from sale_items where sale_id = v_sale_2) then
    raise exception 'TEST FAILED: cashier one can see cashier two''s line items' using errcode = 'ZZ999';
  end if;

  if not exists (select 1 from sale_payments where sale_id = v_sale_1) then
    raise exception 'TEST FAILED: cashier one cannot see their own sale''s payment' using errcode = 'ZZ999';
  end if;
  if exists (select 1 from sale_payments where sale_id = v_sale_2) then
    raise exception 'TEST FAILED: cashier one can see cashier two''s payment' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: sale_items and sale_payments follow the same own-sale split';
end $$;
reset role;
reset request.jwt.claim.sub;

-- ── 4. Owner still sees every sale, item and payment ─────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
do $$
declare
  v_sale_1 uuid := current_setting('covis.sale_1')::uuid;
  v_sale_2 uuid := current_setting('covis.sale_2')::uuid;
  v_count int;
begin
  select count(*) into v_count from sales where id in (v_sale_1, v_sale_2);
  if v_count <> 2 then
    raise exception 'TEST FAILED: the Owner (reports.view) should see both cashiers'' sales, saw %', v_count
      using errcode = 'ZZ999';
  end if;

  select count(*) into v_count from sale_items where sale_id in (v_sale_1, v_sale_2);
  if v_count <> 2 then
    raise exception 'TEST FAILED: the Owner should see both sales'' line items, saw %', v_count
      using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: reports.view still sees the whole business, unrestricted';
end $$;
reset role;
reset request.jwt.claim.sub;

-- ── 5. Refunds are scoped by who processed the RETURN, not the sale ──────
--
-- The refund-only role (603) rings up and refunds its OWN sale, so it
-- never needs to read cashier one's sale_items (a separate, documented
-- interaction — see the migration's comment on refunds_select).

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000603';
do $$
declare v_sale uuid; v_item uuid; v_refund uuid;
begin
  select create_sale(
    (select branch_a from cov_ids), '00000000-0000-0000-0000-000000000603', null, 'cash', 40,
    jsonb_build_array(jsonb_build_object('variant_id', (select item from cov_ids), 'quantity', 1))
  ) into v_sale;
  select id into v_item from sale_items where sale_id = v_sale;

  select create_refund(v_sale, '00000000-0000-0000-0000-000000000603', 'cash', null,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 1, 'restock', true))
  ) into v_refund;

  perform set_config('covis.refund_1', v_refund::text, false);
  raise notice 'FIXTURE: the refund-only role refunded its own sale as refund %', v_refund;
end $$;
reset role;
reset request.jwt.claim.sub;

-- A second refund, on cashier one's sale, processed by the Owner —
-- the Owner is unrestricted either way, but this gives a refund whose
-- cashier_id is neither 601 nor 603, to confirm neither sees it.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
do $$
declare v_refund uuid; v_item uuid; v_sale_1 uuid := current_setting('covis.sale_1')::uuid;
begin
  select id into v_item from sale_items where sale_id = v_sale_1;
  select create_refund(v_sale_1, '00000000-0000-0000-0000-000000000001', 'cash', null,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity', 1, 'restock', true))
  ) into v_refund;
  perform set_config('covis.refund_2', v_refund::text, false);
  raise notice 'FIXTURE: the Owner refunded cashier one''s sale as refund %', v_refund;
end $$;
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000603';
do $$
declare
  v_refund_1 uuid := current_setting('covis.refund_1')::uuid;
  v_refund_2 uuid := current_setting('covis.refund_2')::uuid;
begin
  if not exists (select 1 from refunds where id = v_refund_1) then
    raise exception 'TEST FAILED: the refund-only role cannot see its own refund' using errcode = 'ZZ999';
  end if;
  if exists (select 1 from refunds where id = v_refund_2) then
    raise exception 'TEST FAILED: the refund-only role can see the Owner''s refund' using errcode = 'ZZ999';
  end if;
  if not exists (select 1 from refund_items where refund_id = v_refund_1) then
    raise exception 'TEST FAILED: the refund-only role cannot see its own refund''s items' using errcode = 'ZZ999';
  end if;
  if exists (select 1 from refund_items where refund_id = v_refund_2) then
    raise exception 'TEST FAILED: the refund-only role can see the Owner''s refund items' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: a refund is scoped to whoever processed it, not the original sale''s cashier';
end $$;
reset role;
reset request.jwt.claim.sub;

-- Cashier one owns the sale refund_2 was made against, but not refund_2
-- itself — seeing your own sale does not mean seeing every correction
-- made against it by someone else.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000601';
do $$
declare v_refund_2 uuid := current_setting('covis.refund_2')::uuid;
begin
  if exists (select 1 from refunds where id = v_refund_2) then
    raise exception 'TEST FAILED: cashier one can see a refund the Owner processed against their sale'
      using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: owning the original sale does not unlock visibility into someone else''s refund on it';
end $$;
reset role;
reset request.jwt.claim.sub;

-- ── 6. The Owner sees both refunds regardless ────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
do $$
declare
  v_count int;
  v_refund_1 uuid := current_setting('covis.refund_1')::uuid;
  v_refund_2 uuid := current_setting('covis.refund_2')::uuid;
begin
  select count(*) into v_count from refunds where id in (v_refund_1, v_refund_2);
  if v_count <> 2 then
    raise exception 'TEST FAILED: the Owner should see both refunds, saw %', v_count using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: reports.view sees every refund, whoever processed it';
end $$;
reset role;
reset request.jwt.claim.sub;

\echo ''
\echo 'All cashier-own-sales-visibility tests passed.'