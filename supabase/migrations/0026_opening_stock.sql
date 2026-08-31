-- Busihub — 0026: opening stock when a product is first added
--
-- Until now a new product always started at zero, and the only way to say
-- what was already on the shelf was a second trip to /inventory/receive.
-- For a shop putting its whole catalogue into Busihub for the first time
-- that is every product, twice.
--
-- What this does NOT do is let anyone write a stock level. Opening stock
-- is a real `receive` movement in the same ledger as everything else, so
-- the answer to "where did these 40 bags come from?" is still a row with a
-- date and a person on it. The only thing that changed is where the form
-- lives.
--
-- Two consequences worth stating, because they are deliberate:
--
--   * It is one transaction. A product created with opening stock either
--     exists with its stock or does not exist at all — no half-created
--     product with nothing on the shelf, and no movement pointing at a
--     variant that was rolled back.
--
--   * create_product still runs as the CALLER, so the movement goes
--     through inventory_movements' own RLS. Someone who may add products
--     but not receive stock is refused (42501) rather than quietly
--     granted a way in through the side door.

-- DROPPED, not replaced: adding an argument creates a second function
-- rather than redefining the first, and every existing 8-argument call
-- would keep resolving to the old body — which silently ignores opening
-- stock. (Exactly the trap 0022 hit with create_sale.) Dropping it means
-- 8-argument callers — the seed, the tests, older code — resolve to the
-- new function and get the default.
drop function if exists create_product(uuid, text, text, text, text, text, text[], jsonb);

create or replace function create_product(
  p_business_id uuid,
  p_name text,
  p_description text,
  p_category text,
  p_unit_of_measure text,
  p_tax_category text,
  p_variant_option_names text[],
  p_variants jsonb,          -- [{sku, barcode, variant_options, cost_price, selling_price, opening_stock}]
  p_branch_id uuid default null -- where the opening stock lands
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
begin
  if p_variants is null or jsonb_array_length(p_variants) < 1 then
    raise exception 'At least one variant is required' using errcode = 'P0001';
  end if;

  -- Is any opening stock actually being claimed? Checked before anything
  -- is written so the branch rules below fail early and clearly.
  for v_variant in select * from jsonb_array_elements(p_variants)
  loop
    -- jsonb_typeof, not `is null`: an ABSENT key gives SQL NULL but a key
    -- holding a JSON null does not, and JSON.stringify writes the latter.
    -- See 0025 — this is the same trap, avoided here on purpose.
    if coalesce(jsonb_typeof(v_variant -> 'opening_stock'), 'null') <> 'null'
       and coalesce((v_variant ->> 'opening_stock')::numeric, 0) <> 0 then
      v_any_stock := true;
    end if;
  end loop;

  if v_any_stock then
    if p_branch_id is null then
      raise exception 'Choose which branch the opening stock is at' using errcode = 'P0001';
    end if;
    if not exists (select 1 from branches where id = p_branch_id and business_id = p_business_id) then
      raise exception 'Invalid branch_id: branch not found' using errcode = 'P0002';
    end if;
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
    )
    returning id into v_variant_id;

    v_opening := case
      when coalesce(jsonb_typeof(v_variant -> 'opening_stock'), 'null') = 'null' then 0
      else coalesce((v_variant ->> 'opening_stock')::numeric, 0)
    end;

    if v_opening < 0 then
      raise exception 'Opening stock cannot be negative' using errcode = 'P0001';
    end if;

    if v_opening > 0 then
      -- Through the ledger, exactly like /inventory/receive. The 0015
      -- BEFORE trigger fills in business_id from the branch and created_by
      -- from auth.uid(), and the AFTER trigger updates the level — none of
      -- which this function is allowed to do by hand.
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
  end loop;

  return v_product_id;
end;
$$;

grant execute on function create_product(uuid, text, text, text, text, text, text[], jsonb, uuid) to authenticated;

comment on function create_product(uuid, text, text, text, text, text, text[], jsonb, uuid) is
  'Creates a product with its variants, and — when opening stock is given — the receive movements that put it on the shelf, all in one transaction. Opening stock is never written to stock_levels directly: it goes through inventory_movements like every other movement, so it still needs inventory.receive and still leaves an auditable row.';
