-- Busihub — security test: direct cross-tenant denial for products &
-- product_variants (security-audit Gap #4, 2026-09 review).
--
-- Every other tenant-scoped table with meaningful test coverage
-- (customers.sql, sales.sql, tenant_isolation_and_rbac.sql, ...) has its
-- own standalone assertion that a second business sees exactly zero of
-- another business's rows. products/product_variants had only INDIRECT
-- coverage until now — through inventory-receiving and sale-creation
-- tests that happen to touch a product along the way — so a regression
-- in products_select/product_variants_select specifically could pass
-- every existing test while still leaking data across tenants. This file
-- closes that gap directly, the same way customers.sql does for
-- `customers`.
--
-- Run against a throwaway Postgres loaded with
-- tests/db-harness/00_stub_supabase.sql + supabase/migrations/*.sql +
-- supabase/seed.sql (see tests/security/README.md).
--
-- Every `TEST FAILED` raise carries SQLSTATE ZZ999, which no handler in
-- this file catches — so a wrongly-succeeding operation can never have
-- its own failure message swallowed by a handler written for a different,
-- expected rejection.

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures: two fresh, otherwise-unused businesses ─────────────────────
-- Self-contained on purpose (neither relies on the demo store or any
-- earlier test file's data) so this test proves isolation between two
-- shops it fully controls, rather than assuming what state prior files
-- left behind.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000100',
   'authenticated', 'authenticated', 'ownerp@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000101',
   'authenticated', 'authenticated', 'ownerq@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000100';
select register_business('Product Isolation Shop P', 'Yaw', 'Owusu');
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000101';
select register_business('Product Isolation Shop Q', 'Abena', 'Darko');
reset role;
reset request.jwt.claim.sub;

create table pxt_ids as
select
  (select id from businesses where slug = 'product-isolation-shop-p') as biz_p,
  (select id from businesses where slug = 'product-isolation-shop-q') as biz_q;

do $$
declare r record;
begin
  select * into r from pxt_ids;
  if r.biz_p is null or r.biz_q is null then
    raise exception 'TEST FIXTURE BROKEN: pxt_ids has a null — register_business() did not produce the expected slugs' using errcode = 'ZZ999';
  end if;
end $$;

grant select on pxt_ids to authenticated;

-- ── shop P creates a product + variant as its own Owner ──────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000100';

insert into products (business_id, name)
select biz_p, 'Shop P Only Product' from pxt_ids;

insert into product_variants (product_id, business_id, sku, selling_price)
select p.id,
       '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
       'SHOPP-SKU-1', 12.50
from products p, pxt_ids
where p.business_id = pxt_ids.biz_p and p.name = 'Shop P Only Product';

reset role;
reset request.jwt.claim.sub;

-- ── shop Q creates its own, unrelated product + variant ───────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000101';

insert into products (business_id, name)
select biz_q, 'Shop Q Only Product' from pxt_ids;

insert into product_variants (product_id, business_id, sku, selling_price)
select p.id,
       '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
       'SHOPQ-SKU-1', 7.00
from products p, pxt_ids
where p.business_id = pxt_ids.biz_q and p.name = 'Shop Q Only Product';

reset role;
reset request.jwt.claim.sub;

create table pxt_p_product as
select id, business_id from products p, pxt_ids
where p.business_id = pxt_ids.biz_p and p.name = 'Shop P Only Product';
grant select on pxt_p_product to authenticated;

create table pxt_p_variant as
select id, business_id from product_variants where sku = 'SHOPP-SKU-1';
grant select on pxt_p_variant to authenticated;

create table pxt_q_product as
select id, business_id from products p, pxt_ids
where p.business_id = pxt_ids.biz_q and p.name = 'Shop Q Only Product';
grant select on pxt_q_product to authenticated;

create table pxt_q_variant as
select id, business_id from product_variants where sku = 'SHOPQ-SKU-1';
grant select on pxt_q_variant to authenticated;

do $$
begin
  if (select count(*) from pxt_p_product) <> 1 or (select count(*) from pxt_p_variant) <> 1
    or (select count(*) from pxt_q_product) <> 1 or (select count(*) from pxt_q_variant) <> 1
  then
    raise exception 'TEST FIXTURE BROKEN: shop P/Q could not create their own product+variant — cannot test isolation of rows that were never created' using errcode = 'ZZ999';
  end if;
  -- The trigger (0013) must have overridden the placeholder business_id
  -- on each variant to match its own product's business, not the other
  -- shop's — otherwise the isolation checks below would be meaningless.
  if (select business_id from pxt_p_variant) <> (select biz_p from pxt_ids)
    or (select business_id from pxt_q_variant) <> (select biz_q from pxt_ids)
  then
    raise exception 'TEST FIXTURE BROKEN: a variant''s business_id does not match its own product''s business — set_product_variant_business_id() is not doing its job' using errcode = 'ZZ999';
  end if;
end $$;

-- ── the actual test: shop Q's session sees ZERO of shop P's rows ─────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000101';

do $$
declare v_count int;
begin
  select count(*) into v_count from products where id = (select id from pxt_p_product);
  if v_count <> 0 then
    raise exception 'TEST FAILED: shop Q''s session can see shop P''s product row via products_select' using errcode = 'ZZ999';
  end if;

  select count(*) into v_count from product_variants where id = (select id from pxt_p_variant);
  if v_count <> 0 then
    raise exception 'TEST FAILED: shop Q''s session can see shop P''s product_variant row via product_variants_select' using errcode = 'ZZ999';
  end if;

  -- A blanket count by business_id is the strongest version of this
  -- assertion: not just "that specific id is hidden" but "shop P
  -- contributes nothing at all" to what shop Q's session can see across
  -- the whole table.
  select count(*) into v_count from products where business_id = (select biz_p from pxt_ids);
  if v_count <> 0 then
    raise exception 'TEST FAILED: shop Q''s session can see % of shop P''s products by business_id', v_count using errcode = 'ZZ999';
  end if;

  select count(*) into v_count from product_variants where business_id = (select biz_p from pxt_ids);
  if v_count <> 0 then
    raise exception 'TEST FAILED: shop Q''s session can see % of shop P''s product_variants by business_id', v_count using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: shop Q sees zero rows of shop P''s products/product_variants, by id and by business_id';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── and the reverse direction: shop P's session sees ZERO of shop Q's rows ─

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000100';

do $$
declare v_count int;
begin
  select count(*) into v_count from products where business_id = (select biz_q from pxt_ids);
  if v_count <> 0 then
    raise exception 'TEST FAILED: shop P''s session can see % of shop Q''s products', v_count using errcode = 'ZZ999';
  end if;

  select count(*) into v_count from product_variants where business_id = (select biz_q from pxt_ids);
  if v_count <> 0 then
    raise exception 'TEST FAILED: shop P''s session can see % of shop Q''s product_variants', v_count using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: shop P sees zero rows of shop Q''s products/product_variants — isolation holds in both directions';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── an UPDATE cannot cross the boundary either ────────────────────────────
-- products_update/product_variants_update are scoped by permission, not
-- directly by business_id in their USING clause — app_has_permission()
-- itself derives the caller's own business_id from auth.uid() (0008), so
-- this also re-confirms that derivation can't be tricked into authorizing
-- a write against a different business's row merely by naming its id.

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000101';

do $$
declare v_rows int;
begin
  update products set status = 'archived' where id = (select id from pxt_p_product);
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'TEST FAILED: shop Q''s session archived shop P''s product (% row(s) affected)', v_rows using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: shop Q cannot update shop P''s product (0 rows affected)';
end $$;

reset role;
reset request.jwt.claim.sub;

-- Belt-and-suspenders: confirm shop P's product is genuinely untouched,
-- the same way payments.sql double-checks a blocked mutation actually
-- left the row alone rather than trusting the row-count alone.
do $$
begin
  if (select status from products where id = (select id from pxt_p_product)) <> 'active' then
    raise exception 'TEST FAILED: shop P''s product status changed even though the update above reported 0 rows affected' using errcode = 'ZZ999';
  end if;
end $$;

\echo ''
\echo 'All products/product_variants direct cross-tenant tests passed.'