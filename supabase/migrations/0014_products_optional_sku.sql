-- Busihub — 0014: make product_variants.sku optional
--
-- Feedback from real usage: not every business assigns a SKU to every
-- item — barcode alone, or neither, is common for small retailers, and
-- Phase 5 originally required one on every variant.
--
-- sku already has two things that keep working once it's nullable:
--   1. `unique (business_id, sku)` — Postgres unique constraints already
--      treat every NULL as distinct from every other NULL by default
--      (standard SQL semantics, and true on this Postgres 16 project
--      since NULLS NOT DISTINCT was never specified), so any number of
--      variants can have no SKU without colliding. Same reasoning
--      barcode's partial unique index already relies on (0013) — sku
--      doesn't even need a partial index for this, a plain unique
--      constraint already behaves this way.
--   2. `check (char_length(trim(sku)) > 0)` — a CHECK constraint whose
--      expression evaluates to NULL (which it will, for a NULL sku) is
--      treated as satisfied by Postgres, not violated; only a FALSE
--      result (e.g. an empty string) is rejected. Verified directly
--      against a real table before writing this migration: inserting
--      NULL succeeded, inserting '' still correctly failed the check.
-- So the only change actually needed is dropping NOT NULL.
alter table product_variants alter column sku drop not null;

-- create_product() (0013) passed sku straight through without the
-- nullif(..., '') it already gave barcode — harmless when sku was
-- required (an empty string was rejected by the check constraint either
-- way), but now that blank is a legitimate "no SKU" choice, a blank form
-- field should become NULL cleanly rather than surfacing a raw check-
-- constraint error. Re-defining the function (safe — this changes its
-- body, not the table it already wrote data into) to match barcode's
-- existing handling.
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
      nullif(v_variant ->> 'sku', ''),
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
