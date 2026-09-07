-- Busihub — 0046: one photo per product/service
--
-- photo_url lives on `products`, not `product_variants` — a Size/Color
-- variant of "the same shirt" shares one picture, matching how name/
-- description/category already work. It stores a Storage OBJECT PATH,
-- never a public URL — same reasoning as service-provider photos (0045):
-- a public bucket would be readable by anyone holding the link, forever,
-- with no permission check at all. The bucket here stays private and
-- RLS-scoped by business_id, and every render resolves the stored path to
-- a short-lived signed URL via lib/storage/product-photos.ts.
--
-- Where it renders differs from 0045 in one deliberate way: a product
-- photo shows on the Products list/detail/edit pages AND on the till's
-- own grid and search results — the till is the single most-loaded
-- screen in the app, often over shop wifi or mobile data, so
-- lib/storage/product-photos.ts signs a whole page of photos in ONE
-- Storage API call (createSignedUrls, not one createSignedUrl per row)
-- and the till markup lazy-loads every thumbnail (loading="lazy") so a
-- photo is only ever fetched once its tile is actually about to be seen.
-- The upload path also downscales/re-encodes a picked photo to a modest
-- size entirely in the browser before it ever leaves the device (see
-- lib/images/downscale-photo-client.ts) — a phone-camera original is
-- typically 3-8 MB, and that is a real, repeated data cost once it is
-- something every till load fetches, not a one-time upload cost.
--
-- The read policy below is deliberately NOT gated by any specific
-- permission — it matches products_select (0013): any active member of
-- the business can already see every product's name/price/category
-- regardless of role, so their photo is no more sensitive than that.
-- Only writing (uploading/replacing/removing) one is gated, by
-- products.create/products.edit below.

alter table products add column photo_url text;

comment on column products.photo_url is
  'Storage object path (not a public URL) for this product''s photo, in the private product-photos bucket added by this migration. One photo per product/service, shown on the Products list, the product''s own page, the edit form, and the till grid/search results. Resolved to a short-lived signed URL by lib/storage/product-photos.ts on every render.';

-- ── private storage for product/service photos ───────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-photos', 'product-photos', false,
  5242880, array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Objects are keyed by path, not a foreign key to products — every policy
-- scopes on the path's own leading folder segment, which the app always
-- writes as the business_id (see lib/storage/product-photos.ts). The
-- SECOND segment is normally the product's id, but for a brand-new
-- product being created for the first time it is instead a random,
-- throwaway token — the photo is uploaded, and its path handed to
-- create_product() below, before the product itself has an id yet. RLS
-- never inspects that segment either way, only the leading business_id
-- one, so this costs nothing.
--
-- storage.objects already has row level security enabled by Supabase
-- itself from project provisioning (0045's file header explains why this
-- migration does not re-issue "alter table storage.objects enable row
-- level security" itself — it would be rejected with "must be owner of
-- table objects").
create policy product_photos_select on storage.objects
  for select
  using (
    bucket_id = 'product-photos'
    and (
      ((storage.foldername(name))[1])::uuid = app_current_business_id()
      or app_is_super_admin()
    )
  );

-- Uploading a photo happens on two different permissions depending on
-- when: as part of creating a brand-new product (products.create, the
-- same permission that already covers a starting price/opening stock —
-- see create_product()'s own header below) or as part of editing an
-- existing one (products.edit). Both are accepted here; which one a
-- given request actually satisfies is enforced again, permission-by-
-- permission, in app/(app)/products/actions.ts.
create policy product_photos_insert on storage.objects
  for insert
  with check (
    bucket_id = 'product-photos'
    and (
      app_has_permission(((storage.foldername(name))[1])::uuid, 'products.create')
      or app_has_permission(((storage.foldername(name))[1])::uuid, 'products.edit')
      or app_is_super_admin()
    )
  );

-- Replacing/removing a photo only ever happens through the edit flow
-- (updateProductDetails/removeProductPhoto) — never at creation, since a
-- brand-new object has nothing to replace yet — so these two are gated
-- by products.edit alone, matching every other catalog-attribute edit
-- (category_id, duration_minutes, available_at_till).
create policy product_photos_update on storage.objects
  for update
  using (
    bucket_id = 'product-photos'
    and (app_has_permission(((storage.foldername(name))[1])::uuid, 'products.edit') or app_is_super_admin())
  )
  with check (
    bucket_id = 'product-photos'
    and (app_has_permission(((storage.foldername(name))[1])::uuid, 'products.edit') or app_is_super_admin())
  );

create policy product_photos_delete on storage.objects
  for delete
  using (
    bucket_id = 'product-photos'
    and (app_has_permission(((storage.foldername(name))[1])::uuid, 'products.edit') or app_is_super_admin())
  );

-- ── column-level enforcement (see 0013's file header) ─────────────────────
--
-- photo_url joins the products.edit-gated bucket alongside category_id/
-- duration_minutes (0041) and available_at_till (0043) — this only fires
-- for an UPDATE (a photo added/changed/removed on an EXISTING product),
-- never for the photo attached at creation time, which create_product()
-- below sets in the same INSERT as the rest of the row and never touches
-- this trigger at all. That split matters: someone with products.create
-- but not products.edit (a real, if uncommon, custom-role combination —
-- every seeded role happens to grant both together, but nothing stops a
-- business from splitting them) can legitimately set a product's very
-- first photo the same way they can set its starting price, but must not
-- be able to change an existing product's photo without products.edit.
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
    or new.available_at_till is distinct from old.available_at_till
    or new.photo_url is distinct from old.photo_url
  ) and not (app_has_permission(new.business_id, 'products.edit') or app_is_super_admin()) then
    raise exception 'Missing permission: products.edit' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function enforce_product_field_permissions() is
  'BEFORE UPDATE trigger: compares OLD vs NEW column-by-column so products.edit and products.archive stay separately enforced even for an UPDATE that reaches the database directly (not through the Server Action). category_id and duration_minutes joined this bucket in 0041; available_at_till joined it in 0043; photo_url joined it in 0046 (only for a change to an EXISTING product — the photo attached at creation time is set by create_product()''s own INSERT and never reaches this trigger). See 0013''s file header.';

-- ── create_product(): p_photo_url ─────────────────────────────────────────
--
-- DROPPED, not just redefined — same trap every prior parameter addition
-- to this function has documented (0026/0040/0041): a plain `create or
-- replace` with one more parameter creates a NEW overload alongside the
-- old 11-argument one rather than replacing it, and every existing caller
-- would keep resolving to the old body, which knows nothing about photos.
drop function if exists create_product(uuid, text, text, uuid, text, text, text[], jsonb, uuid, text, integer);

create or replace function create_product(
  p_business_id uuid,
  p_name text,
  p_description text,
  p_category_id uuid,
  p_unit_of_measure text,
  p_tax_category text,
  p_variant_option_names text[],
  p_variants jsonb,
  p_branch_id uuid default null,
  p_type text default 'product',
  p_duration_minutes integer default null,
  -- Storage object path, already uploaded by the caller (under a random
  -- token in place of the not-yet-known product id — see this file's
  -- storage section above) before this function ever runs. Set directly
  -- in the INSERT below, exactly like a starting variant price or opening
  -- stock, so a caller only needs products.create to give a brand-new
  -- product its first photo, never products.edit.
  p_photo_url text default null
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

  if p_category_id is not null
     and not exists (select 1 from categories where id = p_category_id and business_id = p_business_id) then
    raise exception 'Invalid category_id: category not found' using errcode = 'P0002';
  end if;

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
    has_variants, variant_option_names, type, duration_minutes, photo_url, created_by
  )
  values (
    p_business_id, p_name, nullif(p_description, ''), p_category_id,
    p_unit_of_measure, p_tax_category, v_has_variants, p_variant_option_names, p_type, v_duration,
    p_photo_url, auth.uid()
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

grant execute on function create_product(uuid, text, text, uuid, text, text, text[], jsonb, uuid, text, integer, text) to authenticated;

comment on function create_product(uuid, text, text, uuid, text, text, text[], jsonb, uuid, text, integer, text) is
  'Atomically creates a product and its initial variant(s), including its starting photo if one was uploaded first. See 0013''s file header for the permission model, 0041 for category_id/duration_minutes, and this file''s header for why the photo is set here rather than via a follow-up UPDATE.';