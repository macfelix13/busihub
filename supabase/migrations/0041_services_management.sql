-- Busihub — 0041: a real Services page, a real categories table, and a
-- per-renderer revenue report.
--
-- Requested directly: a dedicated Services management page — list, add,
-- edit, deactivate, search, filter — built "in line with the Products
-- page" (the user's own words) rather than as a parallel system. Most of
-- the plumbing already exists (0040 made a service a products row with
-- type='service'); this migration closes the three gaps a genuine
-- services page needs and the user chose not to defer:
--
--   1. Categories become a REAL per-business table instead of free text
--      on products.category, shared by products and services alike.
--   2. products.duration_minutes, for a service's length.
--   3. service_provider_performance(), a "revenue by renderer" report —
--      mirroring staff_performance() (0030) but attributing individual
--      SERVICE LINE revenue to sale_items.rendered_by, not the whole
--      sale to sales.cashier_id. One checkout can have a different
--      cashier than renderer, and several renderers across its lines
--      (barber A did the braiding, barber B did the dreadlocks) — this
--      is exactly the case staff_performance() cannot answer.
--
-- Four forks were discussed with the user before writing any of this
-- (rather than guessed at), and all four answers are reflected below:
--   - Who can be named as a service's renderer at sale time: unchanged —
--     any active staff member, chosen at sale. No new "provider" tag.
--   - Categories: build the real table now (this migration), shared by
--     products AND services — not a services-only concept.
--   - Reporting: build a basic "revenue by renderer" report now, as a
--     new section on the existing /reports/sales page (see the
--     application-layer changes) rather than a new route.
--   - A confirmation dialog before deleting/deactivating: added to both
--     Products and Services (application layer only — no schema change
--     needed for that piece).
--
-- CATEGORIES — modelled on expense_categories (0031), not invented fresh
--
-- Same shape, same reasoning: per-business, seeded with a starting set at
-- registration, archived rather than deleted, RLS scoped to a coarse
-- OR-of-permissions. The one deliberate difference from expense_categories
-- is which permissions gate it: this project has never backfilled a new
-- permission onto an already-registered business's roles (0040's own
-- header makes the same point about services itself), so — exactly like
-- services reusing products.* instead of inventing services.* — a new
-- categories.* permission set would leave every existing business unable
-- to manage categories until a separate backfill touched every tenant's
-- role_permissions. Categories reuse products.create (add a category) and
-- products.edit (rename, re-describe, re-icon, archive/restore a
-- category) instead. Needs no backfill, and matches the fact that a
-- category is a piece of the product catalog, not a separate resource.
--
-- products.category (free text) IS FULLY REPLACED, not kept alongside a
-- new category_id — the user's own instruction was that this new table is
-- "shared by products and services", which means changing how products
-- are categorized too, and the master spec is explicit that Busihub must
-- not carry two structures for the same thing. Every existing free-text
-- value is preserved by being turned into a real category row (case-
-- insensitively deduped per business) before the old column is dropped —
-- nothing is silently discarded.

-- ═══════════════════════════════════════════════════════════════════════
-- ── categories ───────────────────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════

create table categories (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name        text not null check (char_length(trim(name)) > 0),
  description text,
  -- A lucide-react icon name (see lib/ui/category-icons.ts for the
  -- curated allowlist the app validates against) — never free-form SVG or
  -- a URL, so this can never become a stored-XSS vector.
  icon        text,
  -- Seeded by Busihub at registration, same purpose as
  -- expense_categories.is_system (0031): tells the starting set apart
  -- from what a shop added, without freezing it from being renamed.
  is_system   boolean not null default false,
  status      text not null default 'active' check (status in ('active', 'archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (business_id, name)
);

create index categories_business_idx on categories (business_id, status);

create trigger set_updated_at
  before update on categories
  for each row execute function set_updated_at();

comment on table categories is
  'Per-business categories shared by products and services alike (products.category_id). Seeded with a starting set at registration; a shop can add its own and archive ones it does not use. Gated by products.create/products.edit — see file header for why this reuses products.* rather than a new permission set.';

alter table categories enable row level security;

-- Anyone who may view, create or edit the catalog needs the category
-- list — it is not optional context, it is what fills the category
-- dropdown on every product/service form and the products list filter.
create policy categories_select on categories
  for select
  using (
    app_has_permission(business_id, 'products.view')
    or app_has_permission(business_id, 'products.create')
    or app_has_permission(business_id, 'products.edit')
    or app_is_super_admin()
  );

create policy categories_insert on categories
  for insert
  with check (app_has_permission(business_id, 'products.create') or app_is_super_admin());

-- Rename/description/icon AND archive/restore all live under products.edit
-- for categories — unlike products themselves, there is no separate
-- pricing tier here to split out, so one permission covers the whole
-- lifecycle of a category once it exists.
create policy categories_update on categories
  for update
  using (app_has_permission(business_id, 'products.edit') or app_is_super_admin())
  with check (app_has_permission(business_id, 'products.edit') or app_is_super_admin());

-- Archived, never hard-deleted — a product or service referencing a
-- category must still resolve, the same rule products themselves follow.
revoke delete on categories from authenticated;

-- ── starting categories ──────────────────────────────────────────────────

create or replace function seed_default_categories(p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into categories (business_id, name, is_system)
  select p_business_id, name, true
  from (values
    ('Hair'),
    ('Nails'),
    ('Beauty'),
    ('Grooming'),
    ('Treatment'),
    ('Other')
  ) as defaults(name)
  on conflict (business_id, name) do nothing;
end;
$$;

comment on function seed_default_categories(uuid) is
  'Gives a business a starting set of categories, shared by products and services. SECURITY DEFINER because it runs inside registration, before the new owner has a role to be checked against — it writes only to the business id it was given and inserts nothing else.';

revoke execute on function seed_default_categories(uuid) from public, authenticated;

-- Every business that already exists.
do $$
declare v_business record;
begin
  for v_business in select id from businesses loop
    perform seed_default_categories(v_business.id);
  end loop;
end $$;

-- New businesses get the starting categories too — a trigger rather than
-- an extra line inside register_business(), same reasoning as
-- seed_expense_categories_trigger (0031): this hangs off the businesses
-- table itself, so every route that creates a business gets the starting
-- categories without anyone remembering to add the call.

create or replace function seed_default_categories_for_new_business()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform seed_default_categories(new.id);
  return new;
end;
$$;

comment on function seed_default_categories_for_new_business() is
  'Gives every newly created business the starting categories. SECURITY DEFINER because it fires during registration, before the owner has a role for RLS to check against.';

create trigger seed_default_categories_trigger
  after insert on businesses
  for each row execute function seed_default_categories_for_new_business();

-- ═══════════════════════════════════════════════════════════════════════
-- ── products.category (text) → products.category_id (uuid) ─────────────
-- ═══════════════════════════════════════════════════════════════════════

alter table products add column category_id uuid references categories(id) on delete set null;

-- Turn every distinct free-text category already in use into a real row,
-- grouped case-insensitively per business so "Hair" and "hair" become one
-- category, not two — and skipped where a category of that name already
-- exists (the six just-seeded defaults, most commonly), so a shop that
-- already typed "Hair" gets the seeded "Hair" back, not a duplicate.
with distinct_free_text as (
  select
    business_id,
    -- MIN picks a single, stable spelling among case variants that only
    -- differ by case (e.g. "hair" vs "Hair") so the inserted name is
    -- deterministic rather than whichever row Postgres happened to scan
    -- last.
    min(trim(category)) as name,
    lower(trim(category)) as lname
  from products
  where category is not null and trim(category) <> ''
  group by business_id, lower(trim(category))
)
insert into categories (business_id, name, is_system)
select d.business_id, d.name, false
from distinct_free_text d
where not exists (
  select 1 from categories c
  where c.business_id = d.business_id and lower(c.name) = d.lname
)
on conflict (business_id, name) do nothing;

-- Point every product at its (possibly just-created) category row.
update products p
set category_id = c.id
from categories c
where c.business_id = p.business_id
  and p.category is not null
  and lower(trim(p.category)) = lower(c.name);

create index products_business_category_id_idx on products (business_id, category_id);

-- The old free-text column is fully retired, not kept alongside — see
-- file header for why this is a genuine replacement, not a duplicate
-- structure. Dropping it also drops products_business_category_idx,
-- which indexed it.
alter table products drop column category;

comment on column products.category_id is
  'A row in categories, shared by products and services. Nullable — "Uncategorized" is a real, supported state, matching the old free-text column''s behaviour. Never trust a client-supplied value here beyond what create_product()/the category_id update path already validate: it must belong to the caller''s own business.';

-- ── products.duration_minutes ─────────────────────────────────────────────
--
-- How long a service takes. Meaningless for a physical product, so — same
-- treatment as opening_stock in create_product() (0040) — it is validated
-- when given but unconditionally forced to null for type='product'
-- regardless of what a caller sends, since it grants no privilege either
-- way and a stray value costs nothing to ignore.

alter table products add column duration_minutes integer
  check (duration_minutes is null or duration_minutes > 0);

comment on column products.duration_minutes is
  'How long a service takes, in minutes. Always null for type=''product'' — create_product()/the details-update path force it, regardless of what is sent. See 0040''s opening_stock-for-services precedent.';

-- ── column-level enforcement: category_id/duration_minutes join the same
--    products.edit bucket category/other details already lived in ────────

create or replace function enforce_product_field_permissions()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status
     and not (app_has_permission(new.business_id, 'products.archive') or app_is_super_admin()) then
    raise exception 'Missing permission: products.archive' using errcode = '42501';
  end if;

  if (
       new.name is distinct from old.name
    or new.description is distinct from old.description
    or new.category_id is distinct from old.category_id
    or new.unit_of_measure is distinct from old.unit_of_measure
    or new.tax_category is distinct from old.tax_category
    or new.variant_option_names is distinct from old.variant_option_names
    or new.has_variants is distinct from old.has_variants
    or new.duration_minutes is distinct from old.duration_minutes
  ) and not (app_has_permission(new.business_id, 'products.edit') or app_is_super_admin()) then
    raise exception 'Missing permission: products.edit' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function enforce_product_field_permissions() is
  'BEFORE UPDATE trigger: compares OLD vs NEW column-by-column so products.edit and products.archive stay separately enforced even for an UPDATE that reaches the database directly (not through the Server Action). category_id and duration_minutes joined this bucket in 0041, replacing the old free-text category column. See 0013''s file header.';

-- ═══════════════════════════════════════════════════════════════════════
-- ── create_product(): p_category_id, p_duration_minutes ─────────────────
-- ═══════════════════════════════════════════════════════════════════════
--
-- DROPPED, not just redefined with a new default parameter — same trap
-- 0026 and 0040 already documented: a parameter TYPE change (p_category
-- text → p_category_id uuid) makes this a DIFFERENT overload from the
-- live one, and every existing 10-argument caller would keep resolving to
-- the old body, which knows nothing about categories or duration.
drop function if exists create_product(uuid, text, text, text, text, text, text[], jsonb, uuid, text);

create or replace function create_product(
  p_business_id uuid,
  p_name text,
  p_description text,
  p_category_id uuid,
  p_unit_of_measure text,
  p_tax_category text,
  p_variant_option_names text[],
  p_variants jsonb,             -- [{sku, barcode, variant_options, cost_price, selling_price, opening_stock}]
  p_branch_id uuid default null, -- where the opening stock lands (products only)
  p_type text default 'product',
  p_duration_minutes integer default null -- services only; see file header
)
returns uuid
language plpgsql
as $$
declare
  v_product_id uuid;
  v_variant    jsonb;
  v_variant_id uuid;
  v_has_variants boolean;
  v_opening    numeric(14, 3);
  v_any_stock  boolean := false;
  v_duration   integer;
begin
  if p_type not in ('product', 'service') then
    raise exception 'Unknown product type' using errcode = '22023';
  end if;

  if p_variants is null or jsonb_array_length(p_variants) < 1 then
    raise exception 'At least one variant is required' using errcode = 'P0001';
  end if;

  -- Never trust a client-supplied id to mean what it claims: a category
  -- from another tenant (or one that simply does not exist) is refused
  -- the same way an unknown branch already is, not silently ignored.
  if p_category_id is not null
     and not exists (select 1 from categories where id = p_category_id and business_id = p_business_id) then
    raise exception 'Invalid category_id: category not found' using errcode = 'P0002';
  end if;

  -- A service has nothing to put on a shelf — opening stock is simply
  -- meaningless for it, so it is never even looked at (not an error to
  -- send it; there is no legitimate UI path that would, and ignoring it
  -- costs nothing since it grants no privilege either way).
  if p_type = 'product' then
    for v_variant in select * from jsonb_array_elements(p_variants)
    loop
      if coalesce(jsonb_typeof(v_variant -> 'opening_stock'), 'null') <> 'null'
         and coalesce((v_variant ->> 'opening_stock')::numeric, 0) <> 0 then
        v_any_stock := true;
      end if;
    end loop;
  end if;

  if v_any_stock then
    if p_branch_id is null then
      raise exception 'Choose which branch the opening stock is at' using errcode = 'P0001';
    end if;
    if not exists (select 1 from branches where id = p_branch_id and business_id = p_business_id) then
      raise exception 'Invalid branch_id: branch not found' using errcode = 'P0002';
    end if;
  end if;

  -- Duration is meaningless for a physical product — forced null
  -- regardless of what was sent, the same treatment opening_stock gets
  -- for a service just above. For a service, a given value must be a
  -- positive whole number of minutes; the column check constraint would
  -- catch a non-positive one too, but this raises the same
  -- counter-friendly P0001 style every other validation in this function
  -- already uses, rather than a raw constraint-violation message.
  if p_type = 'service' then
    if p_duration_minutes is not null and p_duration_minutes <= 0 then
      raise exception 'Duration must be a positive number of minutes' using errcode = 'P0001';
    end if;
    v_duration := p_duration_minutes;
  else
    v_duration := null;
  end if;

  v_has_variants := coalesce(array_length(p_variant_option_names, 1), 0) > 0;

  insert into products (
    business_id, name, description, category_id, unit_of_measure, tax_category,
    has_variants, variant_option_names, type, duration_minutes, created_by
  )
  values (
    p_business_id, p_name, nullif(p_description, ''), p_category_id,
    p_unit_of_measure, p_tax_category, v_has_variants, p_variant_option_names, p_type, v_duration, auth.uid()
  )
  returning id into v_product_id;

  for v_variant in select * from jsonb_array_elements(p_variants)
  loop
    insert into product_variants (
      product_id, sku, barcode, variant_options, cost_price, selling_price, is_default
    )
    values (
      v_product_id,
      nullif(v_variant ->> 'sku', ''),
      nullif(v_variant ->> 'barcode', ''),
      coalesce(v_variant -> 'variant_options', '{}'::jsonb),
      coalesce((v_variant ->> 'cost_price')::numeric, 0),
      (v_variant ->> 'selling_price')::numeric,
      not v_has_variants
    )
    returning id into v_variant_id;

    if p_type = 'product' then
      v_opening := case
        when coalesce(jsonb_typeof(v_variant -> 'opening_stock'), 'null') = 'null' then 0
        else coalesce((v_variant ->> 'opening_stock')::numeric, 0)
      end;

      if v_opening < 0 then
        raise exception 'Opening stock cannot be negative' using errcode = 'P0001';
      end if;

      if v_opening > 0 then
        insert into inventory_movements (
          business_id, branch_id, variant_id, quantity_delta, reason,
          reference_type, reference_id, note
        )
        values (
          '00000000-0000-0000-0000-000000000000', -- replaced by the trigger
          p_branch_id, v_variant_id, v_opening, 'receive',
          'product', v_product_id, 'Opening stock'
        );
      end if;
    end if;
  end loop;

  return v_product_id;
end;
$$;

grant execute on function create_product(uuid, text, text, uuid, text, text, text[], jsonb, uuid, text, integer) to authenticated;

comment on function create_product(uuid, text, text, uuid, text, text, text[], jsonb, uuid, text, integer) is
  'Creates a product or a service (p_type) with its variants. category_id (0041) replaces the old free-text category and is validated against the caller''s own business. duration_minutes is validated then stored for a service, forced null for a product. For a product with opening stock, also writes the receive movement(s) that put it on the shelf, all in one transaction. See 0040/0041 headers.';

-- ═══════════════════════════════════════════════════════════════════════
-- ── service_provider_performance(): revenue by renderer ─────────────────
-- ═══════════════════════════════════════════════════════════════════════
--
-- SECURITY INVOKER throughout, like every other reporting function in
-- Busihub (0032's own header), so RLS decides what is counted — no
-- special-cased bypass of tenant isolation for a report.
--
-- Deliberately NOT built from staff_performance(): that function
-- attributes a sale's FULL total to whoever the sale's cashier_id is
-- (who rang it up). This attributes each SERVICE LINE's own revenue to
-- whoever sale_items.rendered_by names (who actually did the work) —
-- a materially different question, since one sale can have a different
-- cashier than renderer, and several renderers across its lines (the
-- barber-A/barber-B example from 0040's own header). Composing this from
-- staff_performance() would silently answer the wrong question; this is
-- built directly from sale_items instead, the same way top_products()
-- (0030) is built line-by-line rather than sale-by-sale.
create or replace function service_provider_performance(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_branch_id uuid default null,
  p_limit int default 10
)
returns table (
  provider_id uuid,
  first_name text,
  last_name text,
  service_count bigint,
  gross_total numeric,
  refunded_total numeric,
  net_total numeric
)
language sql
stable
as $$
  with scoped as (
    select si.id, si.rendered_by, si.line_total
    from sale_items si
    join sales s on s.id = si.sale_id
    where s.status = 'completed'
      and si.rendered_by is not null
      and (p_from is null or s.created_at >= p_from)
      and (p_to is null or s.created_at <= p_to)
      and (p_branch_id is null or s.branch_id = p_branch_id)
  ),
  rendered as (
    select rendered_by, count(*) as lines, sum(line_total) as amount
    from scoped group by rendered_by
  ),
  -- The refund is charged to whoever rendered the original line — the
  -- question being asked here is "how much of what they did stuck?" —
  -- not to whoever pressed the refund button.
  returned as (
    select sc.rendered_by, sum(ri.line_total) as amount
    from refund_items ri
    join scoped sc on sc.id = ri.sale_item_id
    group by sc.rendered_by
  )
  select
    rendered.rendered_by,
    pr.first_name,
    pr.last_name,
    rendered.lines,
    rendered.amount,
    coalesce(returned.amount, 0),
    rendered.amount - coalesce(returned.amount, 0)
  from rendered
  left join returned on returned.rendered_by = rendered.rendered_by
  left join profiles pr on pr.id = rendered.rendered_by
  order by 7 desc
  limit least(greatest(coalesce(p_limit, 10), 1), 100);
$$;

grant execute on function service_provider_performance(timestamptz, timestamptz, uuid, int) to authenticated;

comment on function service_provider_performance(timestamptz, timestamptz, uuid, int) is
  'Per-renderer service revenue and returns over a period, attributed from sale_items.rendered_by (who did the work), not sales.cashier_id (who rang it up) — see staff_performance() (0030) for the cashier-based equivalent and this function''s own comment for why the two cannot be composed from one another. Runs as the caller.';