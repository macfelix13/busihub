-- Busihub — 0013: products & product variants (Phase 5)
--
-- Every sellable item is a product_variants row — even a "simple" product
-- with no real variation gets exactly one variant (is_default = true), so
-- every later phase that needs a price/SKU/barcode/stock level (inventory,
-- POS, sales) always reads from the same place regardless of whether the
-- product happens to have Size/Color-style options. products holds the
-- shared catalog info (name, category, tax treatment); product_variants
-- holds everything that can differ per SKU (price, barcode, stock later).
--
-- Permission model (see supabase/migrations/0011 for exactly which seeded
-- role gets which of these — Inventory Manager is the interesting case:
-- create + edit, but neither archive nor change_price):
--   products.create        — create a new product, including its initial
--                             variant(s) and their starting prices.
--   products.edit          — edit a product's non-status fields, edit a
--                             variant's non-price fields (sku/barcode/
--                             variant_options), and add a brand-new variant
--                             to an existing product (its starting price
--                             is a "create", same reasoning as above).
--   products.archive       — flip a product's or variant's status between
--                             active/archived. Deliberately separate from
--                             .edit — an Inventory Manager can restock and
--                             adjust catalog details but not discontinue
--                             a line.
--   products.change_price  — change cost_price/selling_price on a variant
--                             that's already on record. Deliberately
--                             separate from .edit and from the initial
--                             price set at creation/add-variant time — the
--                             idea being "listing something new" is
--                             inventory work, "repricing something already
--                             live" is a pricing decision reserved to
--                             Manager/Owner.
-- RLS below is a coarse row-level backstop (OR of every permission that
-- could legitimately touch the row) — plain RLS can't see which *columns*
-- an UPDATE actually changes. That column-level split is enforced twice:
-- once in the Server Actions (app/(app)/products/actions.ts), which is
-- what gives a clean error message and never even builds an update
-- payload with a field the caller isn't allowed to touch, and again by
-- the enforce_*_field_permissions triggers further down, which compare
-- OLD vs NEW column-by-column and raise if a changed column needs a
-- permission the caller doesn't have — a real database-level backstop,
-- not just app-layer trust, so a request that bypassed the app entirely
-- (a raw call against Supabase's API with a valid session) still can't
-- reprice or archive without the right permission. This was found by
-- testing it directly against local Postgres, not assumed: a first pass
-- of this migration had only the coarse row-level policy below, and a
-- direct SQL UPDATE as an Inventory Manager (products.edit, but neither
-- products.archive nor products.change_price) was able to change a
-- variant's price and status anyway — RLS's OR-of-permissions check
-- doesn't know status/price are gated separately from everything else.

create table products (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null references businesses(id) on delete cascade,
  name                 text not null check (char_length(trim(name)) > 0),
  description          text,
  category             text,
  unit_of_measure      text not null default 'each',
  tax_category         text not null default 'standard'
                         check (tax_category in ('standard', 'zero_rated', 'exempt')),
  has_variants         boolean not null default false,
  -- Names of the option axes that vary per SKU, e.g. {Size, Color}. Empty
  -- for a "simple" product. Kept in sync with has_variants by the check
  -- below rather than trusting the two to be set consistently by callers.
  variant_option_names text[] not null default '{}',
  status               text not null default 'active' check (status in ('active', 'archived')),
  created_by           uuid references profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (business_id, name),
  check (has_variants = (coalesce(array_length(variant_option_names, 1), 0) > 0))
);

create index products_business_id_idx on products (business_id);
create index products_business_category_idx on products (business_id, category);

create trigger set_updated_at
  before update on products
  for each row execute function set_updated_at();

comment on table products is 'Shared catalog info for a sellable item. Prices/SKUs/barcodes live on product_variants — every product has at least one variant, even if it has no real variation (see file header).';

create table product_variants (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid not null references products(id) on delete cascade,
  -- Denormalized from products.business_id by the trigger below (never
  -- trust a client-supplied value here) so RLS can scope this table
  -- directly instead of subquerying through products on every check.
  business_id      uuid not null references businesses(id) on delete cascade,
  sku              text not null check (char_length(trim(sku)) > 0),
  barcode          text,
  -- e.g. {"Size": "M", "Color": "Red"}; '{}' for a simple product's single
  -- default variant.
  variant_options  jsonb not null default '{}'::jsonb,
  cost_price       numeric(14, 2) not null default 0 check (cost_price >= 0),
  selling_price    numeric(14, 2) not null check (selling_price >= 0),
  -- True only for the single auto-created variant of a simple (non-variant)
  -- product — lets later phases (POS/cart) tell "just sell this" apart
  -- from "which variant?" without re-deriving it from variant_options.
  is_default       boolean not null default false,
  status           text not null default 'active' check (status in ('active', 'archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (business_id, sku)
);

create index product_variants_product_id_idx on product_variants (product_id);
create index product_variants_business_id_idx on product_variants (business_id);

-- A barcode is optional but must be unique per business when present.
-- A plain UNIQUE constraint would treat every NULL as distinct already
-- (standard SQL NULL semantics), but a partial index says so explicitly
-- and matches the style of branches_one_main_per_business_idx (0003).
create unique index product_variants_business_barcode_idx
  on product_variants (business_id, barcode)
  where barcode is not null;

create trigger set_updated_at
  before update on product_variants
  for each row execute function set_updated_at();

comment on table product_variants is 'One row per sellable SKU. Every product has >=1 variant; a "simple" product (has_variants = false) has exactly one, with is_default = true and variant_options = {}.';

create or replace function set_product_variant_business_id()
returns trigger
language plpgsql
as $$
begin
  select business_id into new.business_id from products where id = new.product_id;

  if new.business_id is null then
    raise exception 'Invalid product_id: product not found' using errcode = 'P0002';
  end if;

  return new;
end;
$$;

comment on function set_product_variant_business_id() is
  'Forces product_variants.business_id to always match its parent product, regardless of what a caller supplies — closes off a cross-tenant escalation where an insert could otherwise claim a different business_id than the product it is actually attached to. Runs BEFORE INSERT, so RLS''s WITH CHECK evaluates the corrected value, not whatever was sent.';

create trigger set_business_id
  before insert on product_variants
  for each row execute function set_product_variant_business_id();

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table products enable row level security;

create policy products_select on products
  for select
  using (business_id = app_current_business_id() or app_is_super_admin());

create policy products_insert on products
  for insert
  with check (app_has_permission(business_id, 'products.create') or app_is_super_admin());

create policy products_update on products
  for update
  using (
    app_has_permission(business_id, 'products.edit')
    or app_has_permission(business_id, 'products.archive')
    or app_is_super_admin()
  )
  with check (
    app_has_permission(business_id, 'products.edit')
    or app_has_permission(business_id, 'products.archive')
    or app_is_super_admin()
  );

-- No delete policy — products are archived, never hard-deleted (a sale
-- referencing a product later in the project must still resolve).

alter table product_variants enable row level security;

create policy product_variants_select on product_variants
  for select
  using (business_id = app_current_business_id() or app_is_super_admin());

create policy product_variants_insert on product_variants
  for insert
  with check (
    app_has_permission(business_id, 'products.create')
    or app_has_permission(business_id, 'products.edit')
    or app_is_super_admin()
  );

create policy product_variants_update on product_variants
  for update
  using (
    app_has_permission(business_id, 'products.edit')
    or app_has_permission(business_id, 'products.archive')
    or app_has_permission(business_id, 'products.change_price')
    or app_is_super_admin()
  )
  with check (
    app_has_permission(business_id, 'products.edit')
    or app_has_permission(business_id, 'products.archive')
    or app_has_permission(business_id, 'products.change_price')
    or app_is_super_admin()
  );

-- ── column-level enforcement (see file header) ────────────────────────────

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
    or new.category is distinct from old.category
    or new.unit_of_measure is distinct from old.unit_of_measure
    or new.tax_category is distinct from old.tax_category
    or new.variant_option_names is distinct from old.variant_option_names
    or new.has_variants is distinct from old.has_variants
  ) and not (app_has_permission(new.business_id, 'products.edit') or app_is_super_admin()) then
    raise exception 'Missing permission: products.edit' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function enforce_product_field_permissions() is
  'BEFORE UPDATE trigger: compares OLD vs NEW column-by-column so products.edit and products.archive stay separately enforced even for an UPDATE that reaches the database directly (not through the Server Action). See file header.';

create trigger enforce_field_permissions
  before update on products
  for each row execute function enforce_product_field_permissions();

create or replace function enforce_product_variant_field_permissions()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status
     and not (app_has_permission(new.business_id, 'products.archive') or app_is_super_admin()) then
    raise exception 'Missing permission: products.archive' using errcode = '42501';
  end if;

  if (new.cost_price is distinct from old.cost_price or new.selling_price is distinct from old.selling_price)
     and not (app_has_permission(new.business_id, 'products.change_price') or app_is_super_admin()) then
    raise exception 'Missing permission: products.change_price' using errcode = '42501';
  end if;

  if (
       new.sku is distinct from old.sku
    or new.barcode is distinct from old.barcode
    or new.variant_options is distinct from old.variant_options
  ) and not (app_has_permission(new.business_id, 'products.edit') or app_is_super_admin()) then
    raise exception 'Missing permission: products.edit' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function enforce_product_variant_field_permissions() is
  'BEFORE UPDATE trigger: same rationale as enforce_product_field_permissions(), but also separates products.change_price (cost_price/selling_price) from products.edit (sku/barcode/variant_options) and products.archive (status).';

create trigger enforce_field_permissions
  before update on product_variants
  for each row execute function enforce_product_variant_field_permissions();

-- ── create_product(): atomic product + initial variant(s) ────────────────
--
-- Mirrors set_main_branch's rationale (0012): a product with zero variants
-- is a broken/unsellable state, so the product row and all of its starting
-- variants are inserted in one transaction — if any variant fails (e.g. a
-- duplicate SKU within the same submission, or a business-wide duplicate
-- via the unique index), the whole thing rolls back instead of leaving a
-- phantom product behind. Deliberately NOT security definer, same as
-- set_main_branch — it runs as the caller, so the RLS policies above
-- apply to its inserts exactly as if the caller ran them directly; that's
-- also what stops p_business_id from being spoofed to another tenant
-- (app_has_permission(p_business_id, ...) only ever returns true for a
-- business the caller actually has a role in).
create or replace function create_product(
  p_business_id uuid,
  p_name text,
  p_description text,
  p_category text,
  p_unit_of_measure text,
  p_tax_category text,
  p_variant_option_names text[],
  p_variants jsonb -- array of {sku, barcode, variant_options, cost_price, selling_price}
)
returns uuid
language plpgsql
as $$
declare
  v_product_id uuid;
  v_variant jsonb;
  v_has_variants boolean;
begin
  if p_variants is null or jsonb_array_length(p_variants) < 1 then
    raise exception 'At least one variant is required' using errcode = 'P0001';
  end if;

  v_has_variants := coalesce(array_length(p_variant_option_names, 1), 0) > 0;

  insert into products (
    business_id, name, description, category, unit_of_measure, tax_category,
    has_variants, variant_option_names, created_by
  )
  values (
    p_business_id, p_name, nullif(p_description, ''), nullif(p_category, ''),
    p_unit_of_measure, p_tax_category, v_has_variants, p_variant_option_names, auth.uid()
  )
  returning id into v_product_id;

  for v_variant in select * from jsonb_array_elements(p_variants)
  loop
    insert into product_variants (
      product_id, sku, barcode, variant_options, cost_price, selling_price, is_default
    )
    values (
      v_product_id,
      v_variant ->> 'sku',
      nullif(v_variant ->> 'barcode', ''),
      coalesce(v_variant -> 'variant_options', '{}'::jsonb),
      coalesce((v_variant ->> 'cost_price')::numeric, 0),
      (v_variant ->> 'selling_price')::numeric,
      not v_has_variants
    );
  end loop;

  return v_product_id;
end;
$$;

grant execute on function create_product(uuid, text, text, text, text, text, text[], jsonb) to authenticated;

comment on function create_product(uuid, text, text, text, text, text, text[], jsonb) is
  'Atomically creates a product and its initial variant(s). See file header for the permission model and set_main_branch (0012) for why this needs to be one transaction.';

