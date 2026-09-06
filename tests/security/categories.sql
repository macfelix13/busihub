-- Busihub — behaviour/security tests for categories (migration 0041).
--
-- Categories are modelled on expense_categories (0031) — see this file's
-- style and tests/security/expenses.sql's own header for the reasoning
-- this mirrors — but gated by products.create/products.edit instead of a
-- category-specific permission set, per 0041's own header (Busihub has
-- never backfilled a new permission onto an already-registered business).
--
-- What is deliberately NOT re-tested here: the one-time free-text
-- products.category -> category_id backfill that 0041 performs on
-- whatever a business already had typed in. That was verified directly
-- against a real, non-empty Postgres database seeded with deliberately
-- messy data (case-variant duplicates like "Hair"/"hair"/"HAIR" within
-- one business, whitespace-padded values, and a null category) before
-- this migration shipped — every duplicate collapsed to one category
-- case-insensitively, no two businesses' data mixed, and every product
-- ended up pointing at the right row. It cannot be re-exercised inside
-- this repeatable suite: the suite always applies every migration in
-- order from an empty database, so by the time this file runs,
-- products.category (the free-text column the backfill reads FROM) has
-- already been dropped — there is nothing left to back-fill from. This
-- file instead tests everything that stays true on every run: seeding,
-- RLS, permission gating, uniqueness, and cross-tenant isolation.
--
-- `TEST FAILED` raises carry SQLSTATE ZZ999, which no handler here catches
-- (the default, P0001/42501 are caught below as expected rejections).

\set ON_ERROR_STOP on
\pset format aligned

-- ── fixtures ─────────────────────────────────────────────────────────────

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000801',
   'authenticated', 'authenticated', 'catowner@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000802',
   'authenticated', 'authenticated', 'catviewer@busihub.dev.example', 'x', now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000803',
   'authenticated', 'authenticated', 'catcreator@busihub.dev.example', 'x', now())
on conflict (id) do nothing;

-- A second business, so every isolation assertion has somewhere to fail.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000801';
select register_business('Category Test Shop', 'Kofi', 'Mensah');
reset role;
reset request.jwt.claim.sub;

create table cat_ids as
select
  (select id from businesses where slug = 'busihub-demo-store')     as biz_a,
  (select id from businesses where slug = 'category-test-shop')     as biz_c,
  (select b.id from branches b where b.business_id =
     (select id from businesses where slug = 'category-test-shop') and b.is_main) as branch_c,
  -- Resolved here, as the superuser fixture setup, specifically so
  -- section 8 below can hand create_product() a category id that
  -- genuinely belongs to another business (simulating a forged/tampered
  -- request) — a live SELECT from inside an `authenticated` session
  -- could never see it in the first place (categories_select is
  -- RLS-scoped), which would make that assertion pass for the wrong
  -- reason (an always-null id, not a rejected foreign one).
  (select id from categories where business_id =
     (select id from businesses where slug = 'busihub-demo-store') and name = 'Hair') as hair_category_a;

grant select on cat_ids to authenticated;

do $$
declare r record;
begin
  select * into r from cat_ids;
  if r.biz_a is null or r.biz_c is null or r.branch_c is null or r.hair_category_a is null then
    raise exception 'TEST FIXTURE BROKEN: cat_ids has a null' using errcode = 'ZZ999';
  end if;
end $$;

-- Two roles in the new business: a "Viewer" (products.view only) and a
-- "Creator" (products.create only, no products.edit) — enough to prove
-- categories_select/insert/update are gated on the right permission each,
-- not just "any product permission at all".
do $$
declare v_biz uuid; v_branch uuid; v_viewer_role uuid; v_creator_role uuid;
begin
  select biz_c, branch_c into v_biz, v_branch from cat_ids;

  insert into roles (business_id, name, description, is_system_role)
    values (v_biz, 'Category Viewer', 'Views the catalog only.', false)
    on conflict do nothing;
  select id into v_viewer_role from roles where business_id = v_biz and name = 'Category Viewer';
  insert into role_permissions (role_id, permission_id)
    select v_viewer_role, id from permissions where key = 'products.view'
    on conflict do nothing;

  insert into roles (business_id, name, description, is_system_role)
    values (v_biz, 'Category Creator', 'Adds new items and categories only.', false)
    on conflict do nothing;
  select id into v_creator_role from roles where business_id = v_biz and name = 'Category Creator';
  insert into role_permissions (role_id, permission_id)
    select v_creator_role, id from permissions where key = 'products.create'
    on conflict do nothing;

  perform set_config('busihub.privileged_write', 'on', true);
  insert into profiles (id, business_id, first_name, last_name, email)
    values
      ('00000000-0000-0000-0000-000000000802', v_biz, 'Viewer', 'Vee', 'catviewer@busihub.dev.example'),
      ('00000000-0000-0000-0000-000000000803', v_biz, 'Creator', 'Cee', 'catcreator@busihub.dev.example')
    on conflict (id) do nothing;
  perform set_config('busihub.privileged_write', 'off', true);

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values
      (v_biz, v_branch, '00000000-0000-0000-0000-000000000802', v_viewer_role, '00000000-0000-0000-0000-000000000801'),
      (v_biz, v_branch, '00000000-0000-0000-0000-000000000803', v_creator_role, '00000000-0000-0000-0000-000000000801')
    on conflict do nothing;

  if exists (
    select 1 from role_permissions rp join permissions p on p.id = rp.permission_id
    where rp.role_id = v_viewer_role and p.key in ('products.create', 'products.edit')
  ) then
    raise exception 'TEST FIXTURE BROKEN: the viewer holds create/edit' using errcode = 'ZZ999';
  end if;
  if exists (
    select 1 from role_permissions rp join permissions p on p.id = rp.permission_id
    where rp.role_id = v_creator_role and p.key = 'products.edit'
  ) then
    raise exception 'TEST FIXTURE BROKEN: the creator holds edit' using errcode = 'ZZ999';
  end if;
end $$;

-- ── 1. Every business gets its own starting categories ───────────────────

do $$
declare v_a int; v_c int; v_shared int; v_names text[];
begin
  select count(*) into v_a from categories where business_id = (select biz_a from cat_ids);
  select count(*) into v_c from categories where business_id = (select biz_c from cat_ids);

  if v_a = 0 then
    raise exception 'TEST FAILED: the existing business got no starting categories' using errcode = 'ZZ999';
  end if;
  -- The one that matters: the AFTER INSERT ON businesses trigger fired
  -- for a business registered AFTER this migration ran, not just the
  -- one-time backfill loop over pre-existing businesses.
  if v_c = 0 then
    raise exception 'TEST FAILED: a newly registered business got no categories' using errcode = 'ZZ999';
  end if;

  -- Sixteen as of 0042 (up from the original six in 0041) — see that
  -- migration's header for why the list grew and stayed duplicate-free.
  select array_agg(name order by name) into v_names
  from categories where business_id = (select biz_c from cat_ids) and is_system;
  if v_names <> array[
    'Beauty', 'Beverages', 'Electronics & Gadgets', 'Fashion & Clothing', 'Footwear & Accessories',
    'Groceries & Food', 'Grooming', 'Hair', 'Health & Wellness', 'Household & Cleaning', 'Nails',
    'Other', 'Skincare', 'Spa & Massage', 'Stationery & Office', 'Treatment'
  ] then
    raise exception 'TEST FAILED: unexpected starting category set: %', v_names using errcode = 'ZZ999';
  end if;

  -- No two starter categories collide in name, case-insensitively — the
  -- exact property the type-to-create form field (0042) depends on
  -- seed_default_categories() itself never violating.
  if (select count(distinct lower(name)) from categories where business_id = (select biz_c from cat_ids) and is_system)
     <> (select count(*) from categories where business_id = (select biz_c from cat_ids) and is_system) then
    raise exception 'TEST FAILED: two starter categories share a name case-insensitively' using errcode = 'ZZ999';
  end if;

  -- Per business, not a shared table. Two shops renaming "Other" must
  -- not rename it for each other.
  select count(*) into v_shared from categories c1
  join categories c2 on c2.id = c1.id
  where c1.business_id <> c2.business_id;
  if v_shared <> 0 then
    raise exception 'TEST FAILED: a category row is shared between businesses' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: every business gets its own starting categories (% and %)', v_a, v_c;
end $$;

-- ── 2. products.view alone can read the list, not add or rename ──────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000802';

do $$
declare v_n int; v_row record;
begin
  select count(*) into v_n from categories where business_id = (select biz_c from cat_ids);
  if v_n = 0 then
    raise exception 'TEST FAILED: products.view could not see the category list' using errcode = 'ZZ999';
  end if;

  begin
    insert into categories (business_id, name) values ((select biz_c from cat_ids), 'Spa Days');
    raise exception 'TEST FAILED: products.view alone could add a category' using errcode = 'ZZ999';
  exception when insufficient_privilege or sqlstate '42501' then
    raise notice 'PASS: adding a category needs products.create, not just products.view';
  end;

  select * into v_row from categories where business_id = (select biz_c from cat_ids) and name = 'Hair';
  update categories set description = 'Hacked' where id = v_row.id;
  -- RLS on UPDATE fails closed by matching zero rows, not by raising —
  -- the same pattern expenses.sql documents in its own header. Reload
  -- and confirm nothing moved, rather than trusting the absence of an
  -- exception.
  perform pg_sleep(0);
  if exists (select 1 from categories where id = v_row.id and description = 'Hacked') then
    raise exception 'TEST FAILED: products.view alone could rename/redescribe a category' using errcode = 'ZZ999';
  end if;
  raise notice 'PASS: editing a category needs products.edit, not just products.view';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 3. products.create can add a category, but not archive one ───────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000803';

do $$
declare v_id uuid;
begin
  insert into categories (business_id, name, description)
    values ((select biz_c from cat_ids), 'Spa Days', 'Half-day packages')
    returning id into v_id;

  if v_id is null then
    raise exception 'TEST FAILED: products.create could not add a category' using errcode = 'ZZ999';
  end if;

  update categories set status = 'archived' where id = v_id;
  if exists (select 1 from categories where id = v_id and status = 'archived') then
    raise exception 'TEST FAILED: products.create alone could archive a category' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: products.create can add a category but cannot archive one — that needs products.edit';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 4. products.edit can rename, re-describe, and archive/restore ────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000801';

do $$
declare v_id uuid;
begin
  select id into v_id from categories where business_id = (select biz_c from cat_ids) and name = 'Spa Days';

  update categories set description = 'Half-day and full-day packages' where id = v_id;
  if not exists (select 1 from categories where id = v_id and description = 'Half-day and full-day packages') then
    raise exception 'TEST FAILED: products.edit could not update a category''s description' using errcode = 'ZZ999';
  end if;

  update categories set status = 'archived' where id = v_id;
  if not exists (select 1 from categories where id = v_id and status = 'archived') then
    raise exception 'TEST FAILED: products.edit could not archive a category' using errcode = 'ZZ999';
  end if;

  update categories set status = 'active' where id = v_id;
  if not exists (select 1 from categories where id = v_id and status = 'active') then
    raise exception 'TEST FAILED: products.edit could not restore an archived category' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: products.edit covers rename/description and archive/restore alike';
end $$;

-- ── 5. Duplicate names are refused per business, not globally ────────────

do $$
begin
  begin
    insert into categories (business_id, name) values ((select biz_c from cat_ids), 'Hair');
    raise exception 'TEST FAILED: a duplicate category name in the same business was accepted' using errcode = 'ZZ999';
  exception when unique_violation then
    raise notice 'PASS: a duplicate category name in the same business is refused';
  end;

  -- The same name in a DIFFERENT business is not a conflict at all — but
  -- inserting into biz_a needs to act as someone who actually holds
  -- products.create THERE, not as this business's owner (RLS would
  -- correctly refuse that on its own, which is not what this assertion
  -- is about).
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
  insert into categories (business_id, name) values ((select biz_a from cat_ids), 'Spa Days');
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000801', true);
  raise notice 'PASS: the same category name is fine in a different business';
end $$;

-- ── 6. No hard delete ─────────────────────────────────────────────────────

do $$
begin
  begin
    delete from categories where business_id = (select biz_c from cat_ids) and name = 'Other';
    raise exception 'TEST FAILED: a category could be hard-deleted' using errcode = 'ZZ999';
  exception when insufficient_privilege or sqlstate '42501' then
    raise notice 'PASS: categories are archived, never hard-deleted (the grant is withdrawn entirely)';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 7. Cross-tenant isolation ──────────────────────────────────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001'; -- the seeded demo store's owner

do $$
declare v_n int; v_foreign_id uuid;
begin
  select count(*) into v_n from categories where business_id = (select biz_c from cat_ids);
  if v_n <> 0 then
    raise exception 'TEST FAILED: another business''s categories were visible (% rows)', v_n using errcode = 'ZZ999';
  end if;

  select id into v_foreign_id from categories where business_id = (select biz_c from cat_ids) limit 1;
  -- RLS makes this look like "not found", not "forbidden" — same
  -- convention every other cross-tenant lookup in this project follows.
  update categories set description = 'Should never land' where id = v_foreign_id;
  if exists (select 1 from categories where id = v_foreign_id and description = 'Should never land') then
    raise exception 'TEST FAILED: a category in another business could be edited' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: a second business sees and can touch none of the first business''s categories';
end $$;

reset role;
reset request.jwt.claim.sub;

-- ── 8. create_product() validates category_id belongs to the caller's own
--    business, exactly like it already validates branch_id ────────────────

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000801';

do $$
declare v_own_cat uuid; v_foreign_cat uuid; v_id uuid;
begin
  select id into v_own_cat from categories where business_id = (select biz_c from cat_ids) and name = 'Hair';

  select create_product(
    (select biz_c from cat_ids), 'Category Test Haircut', null, v_own_cat, 'each', 'standard', '{}'::text[],
    '[{"sku":"CATT-1","barcode":"","variant_options":{},"cost_price":0,"selling_price":50}]'::jsonb,
    null, 'service'
  ) into v_id;

  if not exists (select 1 from products where id = v_id and category_id = v_own_cat) then
    raise exception 'TEST FAILED: a valid category_id from the caller''s own business was not recorded' using errcode = 'ZZ999';
  end if;

  select hair_category_a into v_foreign_cat from cat_ids;

  begin
    perform create_product(
      (select biz_c from cat_ids), 'Category Test Should Fail', null, v_foreign_cat, 'each', 'standard', '{}'::text[],
      '[{"sku":"CATT-2","barcode":"","variant_options":{},"cost_price":0,"selling_price":50}]'::jsonb
    );
    raise exception 'TEST FAILED: a category_id from another business was accepted' using errcode = 'ZZ999';
  exception when sqlstate 'P0002' then
    raise notice 'PASS: create_product() refuses a category_id that does not belong to the caller''s business (%)', sqlerrm;
  end;

  -- A null category_id is still a supported, non-error "Uncategorized"
  -- state — matching the old free-text column's behaviour exactly.
  select create_product(
    (select biz_c from cat_ids), 'Category Test Uncategorized', null, null, 'each', 'standard', '{}'::text[],
    '[{"sku":"CATT-3","barcode":"","variant_options":{},"cost_price":0,"selling_price":50}]'::jsonb
  ) into v_id;
  if not exists (select 1 from products where id = v_id and category_id is null) then
    raise exception 'TEST FAILED: a null category_id was not accepted as Uncategorized' using errcode = 'ZZ999';
  end if;

  raise notice 'PASS: create_product() accepts a valid category_id or none at all';
end $$;

reset role;
reset request.jwt.claim.sub;

\echo ''
\echo 'All categories tests passed.'