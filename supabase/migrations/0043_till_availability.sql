-- Busihub — 0043: "some products and services should be available in the
-- till" — a new, independent flag for whether an item shows up in the
-- till's own search, separate from active/archived.
--
-- Before this, the till showed EVERY active product/service automatically
-- (app/(app)/till/page.tsx's query only ever filtered on status='active').
-- Requested directly: some items in the catalog should stay out of the
-- till without being archived — archiving hides something from reports,
-- price lists, and the catalog generally; this is narrower; it only hides
-- something from checkout. A clarifying question was asked before writing
-- any code (per this project's standing rule): should this be a brand-new
-- independent toggle, defaulting to visible for everything that already
-- exists, or something else (e.g. tied to categories or branches)? The
-- answer was the new independent toggle, defaulting to true — nothing
-- currently sellable disappears from the till the moment this migration
-- runs.
--
-- Modelled on how duration_minutes/category_id joined the products.edit
-- bucket in 0041 — a plain catalog attribute, not a lifecycle transition
-- like archiving, so no confirmation dialog and no new permission: gated
-- by the products.edit any other catalog-attribute edit already needs.

alter table products add column available_at_till boolean not null default true;

comment on column products.available_at_till is
  'Whether this product/service shows up in the till''s own search — independent of status (an item can stay in the catalog, fully active, while being hidden from checkout; archiving it hides it from everywhere, this only hides it from the till). Defaults to true so nothing already sellable silently vanished from the till when this column was introduced. Gated by products.edit, same as category_id/duration_minutes (0041) — see enforce_product_field_permissions() below.';

-- The till's own query (app/(app)/till/page.tsx) filters on
-- (status, available_at_till) together — a small shop's catalog is at
-- most a few hundred rows, but this keeps that lookup index-backed rather
-- than a sequential scan as a catalog grows.
create index products_till_visibility_idx on products (business_id, status, available_at_till);

-- ── enforce_product_field_permissions(): available_at_till joins the ────
--    products.edit bucket, alongside category_id/duration_minutes ───────
--
-- Redefined, not left alone — a column left OUT of this trigger entirely
-- is not "extra permissive by default", it is UNCHECKED at the database
-- layer, relying solely on the Server Action never offering a way to set
-- it. This project's own standing rule is that the database is the last
-- line of defense regardless of what the application layer did (see
-- docs/SECURITY.md), so this trigger must explicitly know about every
-- column products.edit is meant to gate — verified directly in this
-- migration's own tests/security/services.sql section 8, which proves a
-- role holding products.archive but NOT products.edit is still refused
-- when it tries to touch this specific column (not just a coarser,
-- easier-to-satisfy RLS check).
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
  ) and not (app_has_permission(new.business_id, 'products.edit') or app_is_super_admin()) then
    raise exception 'Missing permission: products.edit' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function enforce_product_field_permissions() is
  'BEFORE UPDATE trigger: compares OLD vs NEW column-by-column so products.edit and products.archive stay separately enforced even for an UPDATE that reaches the database directly (not through the Server Action). category_id and duration_minutes joined this bucket in 0041; available_at_till joined it in 0043. See 0013''s file header.';