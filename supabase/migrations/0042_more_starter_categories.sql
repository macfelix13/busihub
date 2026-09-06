-- Busihub — 0042: a broader starter category list, and letting the
-- product/service form create a category by typing it (application layer
-- only — no schema change needed for that half).
--
-- Requested directly, after 0041 shipped a real categories table: two
-- follow-ups to how categories actually get used day to day.
--
--   1. "categories... should be optional and ability to write your own
--      category" — categories were already optional (a product/service
--      can stay "Uncategorized"; category_id has always allowed null).
--      The real ask was the second half: don't force a trip to
--      Products > Categories before a brand-new category can be used.
--      This is entirely an application-layer change — see
--      app/(app)/products/actions.ts's resolveCategoryId() and
--      components/ui/category-combobox.tsx — the product/service form's
--      category box now accepts a typed name directly: an existing name
--      is reused (matched case-insensitively, so "hair" and "Hair" can
--      never become two rows), and a genuinely new one is created on
--      save, still gated by products.create exactly like the dedicated
--      Categories page already is (docs/RBAC.md's "Categories reuse
--      products.*"). Nothing in this migration enforces that on its own
--      — categories.name has never had a case-insensitive uniqueness
--      constraint (0041's unique(business_id, name) is case-sensitive,
--      same as the rest of this project's naming columns), so the
--      no-duplicates guarantee here is an application-layer one, same as
--      it already was for the free-text -> category backfill 0041 itself
--      performed.
--
--   2. "should be more [of the seeded starter categories]" — six
--      (Hair/Nails/Beauty/Grooming/Treatment/Other) undersold a table
--      meant to serve retail shops as much as salons. Expanded to
--      sixteen, spanning general retail alongside the original salon-
--      leaning set, with the original six preserved (renaming/archiving
--      what a shop doesn't want is already one click on the Categories
--      page — this migration only changes what a business STARTS with).
--
-- Same idempotent pattern 0041 used for the original six:
-- seed_default_categories() is redefined with the fuller list, then
-- re-run for every business that already exists. `on conflict
-- (business_id, name) do nothing` means a business that renamed or
-- archived one of the original six is untouched — only the ten NEW names
-- are added, and only where a category of that exact name doesn't
-- already exist for that business. New businesses get the full sixteen
-- from the same AFTER INSERT trigger 0041 already wired up — no change
-- needed there.

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
    ('Beauty'),
    ('Beverages'),
    ('Electronics & Gadgets'),
    ('Fashion & Clothing'),
    ('Footwear & Accessories'),
    ('Groceries & Food'),
    ('Grooming'),
    ('Hair'),
    ('Health & Wellness'),
    ('Household & Cleaning'),
    ('Nails'),
    ('Other'),
    ('Skincare'),
    ('Spa & Massage'),
    ('Stationery & Office'),
    ('Treatment')
  ) as defaults(name)
  on conflict (business_id, name) do nothing;
end;
$$;

comment on function seed_default_categories(uuid) is
  'Gives a business a starting set of categories, shared by products and services — sixteen as of 0042 (spanning general retail, not just salon services), up from the original six in 0041. SECURITY DEFINER because it runs inside registration, before the new owner has a role to be checked against — it writes only to the business id it was given and inserts nothing else. on conflict do nothing means re-running this (as this migration does, for every pre-existing business) only ever adds missing starter categories, never resurrects or renames one a business already changed.';

-- Every business that already exists gets the ten new names it doesn't
-- already have. A business that renamed "Other" to something else, or
-- archived "Treatment", is unaffected — on conflict do nothing only skips
-- rows that would collide on (business_id, name); it never touches an
-- existing row's status or name.
do $$
declare v_business record;
begin
  for v_business in select id from businesses loop
    perform seed_default_categories(v_business.id);
  end loop;
end $$;