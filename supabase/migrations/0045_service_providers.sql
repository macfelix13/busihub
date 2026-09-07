-- Busihub — 0045: service providers — barbers, nail techs, and other
-- staff who render a service but never sign in.
--
-- Requested directly: "have ability to create staff such as barbers,
-- nail tech, .... so we can link exact staff who rendered a particular
-- service, we will also have reports on service staff so we track
-- individual performances." Migrations 0040/0041 already let a service
-- line name whoever rendered it — but only from the pool of active
-- `profiles`, i.e. people who can actually sign in to Busihub. Plenty of
-- real shops pay a chair or a booth to someone who never touches the
-- till at all — a barber, a braider, a nail tech who is on the floor and
-- on the payroll but has no reason to ever log in. This migration adds
-- that second pool.
--
-- Three forks were discussed with the user before writing any of this:
--
--   1. Login or no login? — NO LOGIN. A service_providers row is a
--      simple named record (name, job title/specialty, phone, photo,
--      status) — not an auth.users account, not a profiles row. This is
--      the deliberate, chosen shape: profiles.id is a foreign key to
--      auth.users(id) (0004) and there is no way around that short of
--      inventing a fake auth account for someone who was explicitly
--      asked NOT to have login credentials. Staff who DO need to sign in
--      keep using the existing invite-a-colleague flow (0036) and keep
--      showing up as `rendered_by`, completely unaffected by this
--      migration.
--   2. One branch, or any branch? — TIED TO ONE BRANCH. branch_id is
--      NOT NULL. A braider works out of one chair at one location; the
--      till's renderer picker (see the application-layer changes) only
--      offers a business's service providers who belong to the branch
--      the sale is actually happening at, the same way it already scopes
--      stock and staff PIN sessions per branch.
--   3. Photos — build the upload now, or defer? — BUILD IT NOW. Nothing
--      in Busihub uploads a file today (grep for avatar_url/logo_url
--      turns up placeholder text columns only), so this is genuinely new
--      infrastructure: a private Supabase Storage bucket plus
--      storage-level policies, not just a text column. See the storage
--      section below for why the bucket is private rather than public.
--
-- THE HARDEST QUESTION: WHERE DOES THIS PLUG INTO A SALE LINE?
--
-- sale_items.rendered_by (0040) is a foreign key to profiles, NOT NULL
-- enforced on a service line by create_sale() itself. The tempting move
-- is to repoint or migrate that column at the new table. This
-- deliberately does NOT do that. A historical rendered_by profile cannot
-- be safely reassigned a single required service_providers.branch_id
-- after the fact — the sale that named them may predate the branch they
-- are on today, or they may have since moved branches, and guessing
-- would silently rewrite history. Instead:
--
--   sale_items.provider_id  →  service_providers(id), alongside the
--   completely untouched sale_items.rendered_by  →  profiles(id).
--
-- Every sale ever recorded keeps meaning exactly what it always meant.
-- create_sale() (rewritten below, same signature — no new overload
-- needed, since the renderer fields live inside the existing p_items
-- jsonb payload) now accepts EITHER rendered_by OR provider_id per
-- service line, validates whichever one was sent, and refuses both being
-- sent at once. service_provider_performance() (also rewritten below,
-- DROPPED first since its OUTPUT columns change) unifies the two pools
-- into one leaderboard instead of reporting on profiles alone.
--
-- PERMISSIONS — reusing users.manage / sales.process, same as 0040/0041's
-- own precedent of never backfilling a new permission onto an
-- already-registered business's roles
--
-- Creating, editing, and archiving a service provider is a staffing
-- decision, not a catalog one — reused under users.manage (the same
-- permission that gates inviting/editing a real staff member, 0036)
-- rather than borrowing products.* the way categories did (0041).
-- Viewing the list is also allowed under sales.process, because the
-- till's own renderer picker needs to read active service providers to
-- offer them at all, and a cashier who can ring up a sale should not be
-- blocked from seeing who is on the floor to attribute it to. No new
-- permission key, so nothing needs backfilling onto any existing
-- business's roles.

-- ═══════════════════════════════════════════════════════════════════════
-- ── service_providers ────────────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════

create table service_providers (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  -- Fixed to one branch (the user's own choice — see file header). Same
  -- on-delete behaviour as every other required branch_id in this schema
  -- (expenses, purchase orders, customers' preferred branch, sales
  -- themselves): a branch that still has a service provider on it cannot
  -- simply vanish out from under them.
  branch_id   uuid not null references branches(id) on delete restrict,
  name        text not null check (char_length(trim(name)) > 0),
  -- Free text, e.g. "Barber", "Nail technician", "Braider" — not a
  -- controlled vocabulary. Shown next to their name wherever they appear
  -- (till picker, reports, this management page).
  title       text,
  phone       text,
  -- The storage OBJECT PATH inside the private service-provider-photos
  -- bucket (below), e.g. "<business_id>/<provider_id>/<filename>" — NOT
  -- a public URL. The bucket is private, so this column alone grants no
  -- access; the app resolves it to a short-lived signed URL at render
  -- time, scoped by the same RLS this table itself uses. Never trust a
  -- client-supplied value here beyond what the update path validates: it
  -- must be a path the caller was actually handed back by a successful
  -- upload of their own.
  photo_url   text,
  status      text not null default 'active' check (status in ('active', 'archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references profiles(id) on delete set null
);

-- The till's renderer picker and this table's own management page both
-- filter by (business, branch, status) together — one index serves both.
create index service_providers_business_branch_idx
  on service_providers (business_id, branch_id, status);

create trigger set_updated_at
  before update on service_providers
  for each row execute function set_updated_at();

comment on table service_providers is
  'Named staff who render a service but never sign in — barbers, nail techs, and the like (no auth.users row, no profiles row; see file header for why this is a deliberate second pool alongside profiles rather than a login-less profile). Fixed to one branch. Archived, never deleted — a sale_items row naming one must still resolve.';

comment on column service_providers.branch_id is
  'Which branch this person works out of. Fixed at creation and editable afterward like any other field on this record — but a sale line naming them (sale_items.provider_id) is validated against the SALE''s own branch at the moment of sale (create_sale, below), not re-checked retroactively if this changes later.';

comment on column service_providers.photo_url is
  'A path inside the private service-provider-photos storage bucket, not a public URL — resolved to a short-lived signed URL by the app at render time. Null means no photo.';

-- ── business_id/branch_id are derived, never trusted from the client ──────
--
-- Same shape as set_expense_context() (0031): business_id is DERIVED from
-- the branch on every insert or update, never read from the payload, so a
-- caller cannot file a service provider against a business they do not
-- belong to by naming it. Runs BEFORE INSERT OR UPDATE so the RLS
-- WITH CHECK below evaluates the corrected business_id, not whatever the
-- caller sent.
create or replace function set_service_provider_context()
returns trigger
language plpgsql
as $$
declare
  v_branch_business uuid;
begin
  select business_id into v_branch_business from branches where id = new.branch_id;
  if v_branch_business is null then
    raise exception 'Invalid branch_id: branch not found' using errcode = 'P0002';
  end if;

  new.business_id := v_branch_business;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  end if;

  return new;
end;
$$;

comment on function set_service_provider_context() is
  'Forces service_providers.business_id to match branch_id (refusing an unknown branch outright) and stamps created_by on insert, so a forged business_id/created_by in the request is never what gets stored. See 0031''s set_expense_context() for the same pattern.';

create trigger set_service_provider_context_trigger
  before insert or update on service_providers
  for each row execute function set_service_provider_context();

-- ── row level security ───────────────────────────────────────────────────

alter table service_providers enable row level security;

-- Both the management page (users.manage) and the till's renderer picker
-- (sales.process) need to read this list — see file header for why
-- viewing is the one thing gated more broadly than create/edit/archive.
create policy service_providers_select on service_providers
  for select
  using (
    app_has_permission(business_id, 'sales.process')
    or app_has_permission(business_id, 'users.manage')
    or app_is_super_admin()
  );

create policy service_providers_insert on service_providers
  for insert
  with check (app_has_permission(business_id, 'users.manage') or app_is_super_admin());

create policy service_providers_update on service_providers
  for update
  using (app_has_permission(business_id, 'users.manage') or app_is_super_admin())
  with check (app_has_permission(business_id, 'users.manage') or app_is_super_admin());

-- Archived, never hard-deleted — a sale_items row naming one must still
-- resolve, the same rule every other archivable record in this schema
-- follows.
revoke delete on service_providers from authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- ── private storage for provider photos ─────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
--
-- PRIVATE, not public. A public bucket would mean anyone holding a photo's
-- URL could load it forever with no permission check at all — exactly the
-- "access by knowing an id/URL" pattern the master spec rules out, even
-- though a uuid-shaped path is not realistically guessable. Instead the
-- bucket stays private and RLS-scoped by business_id (same as every
-- table in this schema), and the app resolves photo_url to a short-lived
-- SIGNED url per render, generated only for a caller this table's own
-- SELECT policy would already let read the row. Uploads are constrained
-- at the bucket level to a handful of image mime types and a 5 MB cap —
-- belt-and-suspenders alongside the same checks the upload server action
-- makes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'service-provider-photos', 'service-provider-photos', false,
  5242880, array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Storage objects are keyed by path, not by a foreign key to
-- service_providers — every policy below scopes on the path's OWN first
-- folder segment, which the app always writes as the business_id (see
-- the upload server action). storage.foldername(name) splits "a/b/c.jpg"
-- into {a, b}; segment [1] is that leading business_id.
alter table storage.objects enable row level security;

create policy service_provider_photos_select on storage.objects
  for select
  using (
    bucket_id = 'service-provider-photos'
    and (
      app_has_permission(((storage.foldername(name))[1])::uuid, 'sales.process')
      or app_has_permission(((storage.foldername(name))[1])::uuid, 'users.manage')
      or app_is_super_admin()
    )
  );

create policy service_provider_photos_insert on storage.objects
  for insert
  with check (
    bucket_id = 'service-provider-photos'
    and (
      app_has_permission(((storage.foldername(name))[1])::uuid, 'users.manage')
      or app_is_super_admin()
    )
  );

create policy service_provider_photos_update on storage.objects
  for update
  using (
    bucket_id = 'service-provider-photos'
    and (
      app_has_permission(((storage.foldername(name))[1])::uuid, 'users.manage')
      or app_is_super_admin()
    )
  )
  with check (
    bucket_id = 'service-provider-photos'
    and (
      app_has_permission(((storage.foldername(name))[1])::uuid, 'users.manage')
      or app_is_super_admin()
    )
  );

-- A replaced or removed photo's old file is deleted outright (unlike a
-- business record, a stray uploaded image file has nothing worth
-- preserving once nothing points at it).
create policy service_provider_photos_delete on storage.objects
  for delete
  using (
    bucket_id = 'service-provider-photos'
    and (
      app_has_permission(((storage.foldername(name))[1])::uuid, 'users.manage')
      or app_is_super_admin()
    )
  );

-- ═══════════════════════════════════════════════════════════════════════
-- ── sale_items.provider_id ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════

alter table sale_items
  add column provider_id uuid references service_providers(id) on delete set null;

comment on column sale_items.provider_id is
  'Who rendered a service line, when that person is a no-login service_providers record rather than a profiles account — the second of the two renderer pools alongside rendered_by (0040). Exactly one of (rendered_by, provider_id) is required for a service line and neither is allowed for a product line; that shape depends on the linked product''s type, which a table CHECK constraint cannot see, so it is enforced inside create_sale() (below) — the same place rendered_by''s own requirement has always been enforced. The one thing a row-local constraint CAN say outright is that both are never set at once — see sale_items_renderer_not_both.';

-- Row-local defense in depth: whichever pool a service line's renderer
-- comes from, it is never both at once. The fuller rule (exactly one
-- required for a service line, neither allowed for a product line) needs
-- to know the linked product's type, which lives in a different table a
-- CHECK constraint cannot query — that half is create_sale()'s job, same
-- as rendered_by's own requirement always has been.
alter table sale_items
  add constraint sale_items_renderer_not_both
  check (not (rendered_by is not null and provider_id is not null));

-- ═══════════════════════════════════════════════════════════════════════
-- ── create_sale(): either renderer pool, for a service line ─────────────
-- ═══════════════════════════════════════════════════════════════════════
--
-- Same signature as the live (0040) function — CREATE OR REPLACE only, no
-- DROP and no new overload needed, because the per-item renderer fields
-- live inside the existing p_items jsonb payload (rendered_by, now also
-- provider_id), not as new positional arguments. Reproduced in full from
-- 0040's live body; changes are marked below.
create or replace function create_sale(
  p_branch_id uuid,
  p_cashier_id uuid,
  p_customer_id uuid,
  p_payment_method text,
  p_amount_tendered numeric,
  p_items jsonb,                  -- [{variant_id, quantity, rendered_by, provider_id}]
  p_payments jsonb default null   -- [{method, amount, momo_number, momo_network}]
)
returns uuid
language plpgsql
as $$
declare
  v_business_id   uuid;
  v_sale_id       uuid;
  v_item          jsonb;
  v_pay           jsonb;
  v_variant       record;
  v_qty           numeric(14, 3);
  v_reference     text;
  v_settings      jsonb;
  v_vat_enabled   boolean;
  v_inclusive     boolean;
  v_vat           numeric;
  v_levies        numeric;
  v_gross         numeric(14, 2);
  v_base          numeric;
  v_line_tax      numeric(14, 2);
  v_line_subtotal numeric(14, 2);
  v_subtotal      numeric(14, 2) := 0;
  v_tax_total     numeric(14, 2) := 0;
  v_total         numeric(14, 2) := 0;
  v_change        numeric(14, 2) := 0;
  v_lines         jsonb := '[]'::jsonb;
  v_tenders       jsonb;
  v_method        text;
  v_amount        numeric(14, 2);
  v_cash          numeric(14, 2) := 0;
  v_momo          numeric(14, 2) := 0;
  v_credit        numeric(14, 2) := 0;
  v_methods       text[] := '{}';
  v_credit_is_total boolean := false;
  v_momo_is_remainder boolean := false;
  v_summary       text;
  v_status        text;
  v_payment_id    uuid;
  -- Who rendered a service line, and whether this line is one at all.
  -- Exactly one of the next two may be set for a service line (0045).
  v_rendered_by   uuid;
  v_provider_id   uuid;
begin
  if p_items is null or jsonb_array_length(p_items) < 1 then
    raise exception 'A sale needs at least one item' using errcode = 'P0001';
  end if;

  -- The cashier is always whoever is actually signed in — never a value
  -- the client chooses (0039). p_cashier_id stays in the signature only
  -- so nothing needs a new overload; a caller may still pass their own
  -- id for clarity, but anything else is refused outright rather than
  -- silently ignored or silently honoured.
  if p_cashier_id is not null and p_cashier_id <> auth.uid() then
    raise exception 'A sale can only be attributed to the account that is signed in' using errcode = '42501';
  end if;

  -- Backwards compatible: a caller that passes no payments (everything
  -- written before this migration, and every existing test) gets exactly
  -- the old single-tender behaviour, derived from the two arguments it
  -- did pass.
  if p_payments is null then
    if p_payment_method not in ('cash', 'credit') then
      raise exception 'Unknown payment method' using errcode = '22023';
    end if;
    -- Note what the old form does NOT carry: an amount for a credit sale.
    -- It passed amount_tendered = 0 there, meaning "the whole total",
    -- which is not known until the lines are priced. The amount is left
    -- out and filled in below rather than validated as a zero payment.
    v_tenders := case
      when p_payment_method = 'credit'
        then jsonb_build_array(jsonb_build_object('method', 'credit'))
      else jsonb_build_array(jsonb_build_object(
        'method', 'cash', 'amount', coalesce(p_amount_tendered, 0)))
    end;
  else
    v_tenders := p_payments;
  end if;

  if jsonb_array_length(v_tenders) < 1 then
    raise exception 'A sale needs at least one payment' using errcode = 'P0001';
  end if;

  select business_id into v_business_id from branches where id = p_branch_id;
  if v_business_id is null then
    raise exception 'Invalid branch_id: branch not found' using errcode = 'P0002';
  end if;

  if p_customer_id is not null then
    if not exists (select 1 from customers where id = p_customer_id and business_id = v_business_id) then
      raise exception 'Invalid customer_id: customer not found' using errcode = 'P0002';
    end if;
  end if;

  -- ── the tenders, before anything is written ───────────────────────────
  for v_pay in select * from jsonb_array_elements(v_tenders)
  loop
    v_method := v_pay ->> 'method';
    if v_method not in ('cash', 'momo', 'credit') then
      raise exception 'Unknown payment method' using errcode = '22023';
    end if;
    if v_method = any (v_methods) then
      raise exception 'The same payment method was given twice' using errcode = 'P0001';
    end if;
    v_methods := v_methods || v_method;

    if v_method = 'cash' then
      -- Cash is the one tender that may be short at this point: it is
      -- allowed to be zero here and checked against the total below,
      -- because the old two-argument form passes the tendered amount.
      v_cash := coalesce((v_pay ->> 'amount')::numeric, 0);
      if v_cash < 0 then
        raise exception 'Cash tendered cannot be negative' using errcode = 'P0001';
      end if;
    elsif v_method = 'credit' and coalesce(jsonb_typeof(v_pay -> 'amount'), 'null') = 'null' then
      -- "The whole total", filled in once the lines are priced.
      v_credit_is_total := true;

    elsif v_method = 'momo' and coalesce(jsonb_typeof(v_pay -> 'amount'), 'null') = 'null' then
      -- "Whatever the cash did not cover", filled in once the lines are
      -- priced. This is how the till asks for a mobile money charge: it
      -- never names the amount, because it does not know the authoritative
      -- total and must not be able to prompt a customer's phone for a
      -- figure of its own choosing.
      v_momo_is_remainder := true;
      if coalesce(v_pay ->> 'momo_number', '') = '' then
        raise exception 'A mobile money payment needs a phone number' using errcode = 'P0001';
      end if;
      if coalesce(v_pay ->> 'momo_network', '') not in ('mtn', 'vod', 'atl') then
        raise exception 'Choose the customer''s mobile money network' using errcode = 'P0001';
      end if;
    else
      v_amount := (v_pay ->> 'amount')::numeric;
      if v_amount is null or v_amount <= 0 then
        raise exception 'Every payment needs an amount greater than zero' using errcode = 'P0001';
      end if;
      if v_method = 'momo' then
        v_momo := v_amount;
        if coalesce(v_pay ->> 'momo_number', '') = '' then
          raise exception 'A mobile money payment needs a phone number' using errcode = 'P0001';
        end if;
        if coalesce(v_pay ->> 'momo_network', '') not in ('mtn', 'vod', 'atl') then
          raise exception 'Choose the customer''s mobile money network' using errcode = 'P0001';
        end if;
      else
        v_credit := v_amount;
      end if;
    end if;
  end loop;

  -- On account is not a tender you can top up at the counter. Part-paying
  -- an account sale is a payment AGAINST the account (0017), recorded
  -- separately — mixing them here would mean re-checking a credit limit
  -- long after the customer has left.
  if (v_credit > 0 or v_credit_is_total) and array_length(v_methods, 1) > 1 then
    raise exception 'An account sale cannot be part-paid at the till' using errcode = 'P0001';
  end if;

  if (v_credit > 0 or v_credit_is_total) and p_customer_id is null then
    raise exception 'A credit sale needs a customer' using errcode = 'P0001';
  end if;

  -- 0020 wrote the account entry as the caller, so the account ledger's
  -- own insert policy demanded customers.view. finalize_sale writes it as
  -- its owner now, which would quietly have dropped that requirement, so
  -- it is asserted here instead of being lost in the refactor.
  if (v_credit > 0 or v_credit_is_total)
     and not (app_has_permission(v_business_id, 'customers.view') or app_is_super_admin()) then
    raise exception 'Missing permission: customers.view' using errcode = '42501';
  end if;

  select tax_settings into v_settings from business_settings where business_id = v_business_id;
  v_vat_enabled := coalesce((v_settings ->> 'vat_enabled')::boolean, false);
  v_inclusive   := coalesce((v_settings ->> 'vat_inclusive')::boolean, true);
  v_vat         := coalesce((v_settings ->> 'vat_rate')::numeric, 0);
  v_levies      := coalesce((v_settings ->> 'nhil_levy_rate')::numeric, 0)
                 + coalesce((v_settings ->> 'getfund_levy_rate')::numeric, 0)
                 + coalesce((v_settings ->> 'covid_levy_rate')::numeric, 0);

  -- FIRST PASS: price every line and total the sale, writing nothing.
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every line needs a quantity greater than zero' using errcode = 'P0001';
    end if;

    -- Also read the product's type, so a service line can skip the stock
    -- machinery entirely further down.
    select v.id, v.sku, v.selling_price, v.cost_price, v.status, p.name, p.tax_category, p.type as product_type
    into v_variant
    from product_variants v
    join products p on p.id = v.product_id
    where v.id = (v_item ->> 'variant_id')::uuid
      and v.business_id = v_business_id;

    if v_variant.id is null then
      raise exception 'Invalid variant_id: product not found' using errcode = 'P0002';
    end if;
    if v_variant.status <> 'active' then
      raise exception 'That product is archived and cannot be sold' using errcode = 'P0001';
    end if;

    -- Who did the work. Required and validated for a service, from
    -- EITHER pool (0045) — ignored entirely for a product; a bogus value
    -- there grants nothing, so it is simply dropped rather than treated
    -- as an error.
    v_rendered_by := nullif(v_item ->> 'rendered_by', '')::uuid;
    v_provider_id := nullif(v_item ->> 'provider_id', '')::uuid;

    if v_variant.product_type = 'service' then
      if v_rendered_by is not null and v_provider_id is not null then
        raise exception 'Choose one renderer for "%", not two', v_variant.name using errcode = 'P0001';
      end if;
      if v_rendered_by is null and v_provider_id is null then
        raise exception 'Choose who rendered "%"', v_variant.name using errcode = 'P0001';
      end if;

      if v_rendered_by is not null then
        if not exists (
          select 1 from profiles
          where id = v_rendered_by and business_id = v_business_id and status = 'active'
        ) then
          raise exception 'That person is not an active member of this business' using errcode = 'P0002';
        end if;
      else
        -- Also branch-scoped, unlike a staff profile: a service provider
        -- (0045) is tied to one branch, so naming one from a different
        -- branch than this sale is refused the same way a foreign
        -- customer or branch id already is, not silently allowed.
        if not exists (
          select 1 from service_providers
          where id = v_provider_id
            and business_id = v_business_id
            and branch_id = p_branch_id
            and status = 'active'
        ) then
          raise exception 'That service provider is not active at this branch' using errcode = 'P0002';
        end if;
      end if;
    else
      v_rendered_by := null;
      v_provider_id := null;
    end if;

    v_gross := round(v_variant.selling_price * v_qty, 2);

    if not v_vat_enabled or v_variant.tax_category in ('zero_rated', 'exempt') then
      v_line_tax := 0;
      v_line_subtotal := v_gross;
    elsif v_inclusive then
      v_base := v_gross / ((1 + v_levies) * (1 + v_vat));
      v_line_subtotal := round(v_base, 2);
      v_line_tax := v_gross - v_line_subtotal;
    else
      v_line_subtotal := v_gross;
      v_line_tax := round((v_gross * v_levies) + ((v_gross * (1 + v_levies)) * v_vat), 2);
      v_gross := v_line_subtotal + v_line_tax;
    end if;

    v_lines := v_lines || jsonb_build_object(
      'variant_id', v_variant.id,
      'description', v_variant.name,
      'sku', v_variant.sku,
      'quantity', v_qty,
      'unit_price', v_variant.selling_price,
      -- What this unit COST us, captured now. Cost prices change; a
      -- profit figure derived from today's cost applied to last month's
      -- sale is not a rounder number, it is a wrong one.
      'unit_cost', coalesce(v_variant.cost_price, 0),
      'tax_category', v_variant.tax_category,
      'line_subtotal', v_line_subtotal,
      'line_tax', v_line_tax,
      'line_total', v_gross,
      'is_service', (v_variant.product_type = 'service'),
      'rendered_by', v_rendered_by,
      'provider_id', v_provider_id
    );

    v_subtotal  := v_subtotal + v_line_subtotal;
    v_tax_total := v_tax_total + v_line_tax;
    v_total     := v_total + v_gross;
  end loop;

  -- An account sale is for the whole total by definition; now that the
  -- lines are priced, we know what that is.
  if v_credit_is_total then
    v_credit := v_total;
  end if;

  if v_momo_is_remainder then
    v_momo := v_total - v_cash;
    if v_momo <= 0 then
      raise exception 'The cash already covers this sale — there is nothing to charge to mobile money'
        using errcode = 'P0001';
    end if;
  end if;

  -- ── does the money add up? ────────────────────────────────────────────
  if v_momo + v_credit > v_total then
    raise exception 'The payments come to more than the sale' using errcode = 'P0001';
  end if;

  if v_credit > 0 and v_credit <> v_total then
    raise exception 'An account sale must be for the whole amount' using errcode = 'P0001';
  end if;

  if v_cash + v_momo + v_credit < v_total then
    raise exception 'Not enough tendered for a total of %', v_total using errcode = 'P0001';
  end if;

  if v_cash > 0 then
    v_change := v_cash - (v_total - v_momo - v_credit);
  end if;

  -- A momo charge has not happened yet — it is a prompt on a phone that
  -- the customer has three minutes to approve.
  v_status := case when v_momo > 0 then 'awaiting_payment' else 'completed' end;

  v_summary := case
    when array_length(v_methods, 1) > 1 then 'split'
    when v_credit > 0 then 'credit'
    when v_momo > 0 then 'momo'
    else 'cash'
  end;

  -- Receipt number, serialised per business so two tills cannot both
  -- claim R-000042.
  perform pg_advisory_xact_lock(hashtextextended('receipt:' || v_business_id::text, 0));

  v_reference := next_receipt_number(v_business_id);

  insert into sales (
    business_id, branch_id, receipt_number, customer_id, status, payment_method,
    subtotal, tax_total, total, amount_tendered, change_given, cashier_id, created_by
  )
  values (
    v_business_id, p_branch_id, v_reference, p_customer_id,
    'awaiting_payment', v_summary,
    v_subtotal, v_tax_total, v_total, v_cash, v_change,
    -- Always the signed-in account (0039) — never p_cashier_id.
    auth.uid(), auth.uid()
  )
  returning id into v_sale_id;

  -- SECOND PASS: the lines. A product line also takes stock out; a
  -- service line never touches the inventory ledger at all — there is
  -- nothing to take off a shelf.
  for v_item in select * from jsonb_array_elements(v_lines)
  loop
    insert into sale_items (
      sale_id, business_id, variant_id, description, sku, quantity,
      unit_price, unit_cost, cost_is_estimated, tax_category,
      line_subtotal, line_tax, line_total, rendered_by, provider_id
    )
    values (
      v_sale_id, v_business_id, (v_item ->> 'variant_id')::uuid,
      v_item ->> 'description', v_item ->> 'sku', (v_item ->> 'quantity')::numeric,
      (v_item ->> 'unit_price')::numeric, (v_item ->> 'unit_cost')::numeric,
      false, -- recorded at the moment of sale, not guessed afterwards
      v_item ->> 'tax_category',
      (v_item ->> 'line_subtotal')::numeric, (v_item ->> 'line_tax')::numeric,
      (v_item ->> 'line_total')::numeric,
      nullif(v_item ->> 'rendered_by', '')::uuid,
      nullif(v_item ->> 'provider_id', '')::uuid
    );

    if not (v_item ->> 'is_service')::boolean then
      insert into inventory_movements (
        business_id, branch_id, variant_id, quantity_delta, reason,
        reference_type, reference_id, note
      )
      values (
        '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
        p_branch_id, (v_item ->> 'variant_id')::uuid, -(v_item ->> 'quantity')::numeric, 'sale',
        'sale', v_sale_id, 'Sold on ' || v_reference
      );
    end if;
  end loop;

  -- THIRD PASS: the tenders themselves.
  for v_pay in select * from jsonb_array_elements(v_tenders)
  loop
    v_method := v_pay ->> 'method';
    v_amount := case
      when v_method = 'cash' then v_cash
      when v_method = 'credit' then v_credit
      when v_method = 'momo' then v_momo
      else (v_pay ->> 'amount')::numeric
    end;

    continue when v_amount is null or v_amount <= 0;

    v_payment_id := gen_random_uuid();

    insert into sale_payments (
      id, business_id, sale_id, branch_id, method, amount, status,
      provider, provider_reference, momo_number, momo_network, settled_at, created_by
    )
    values (
      v_payment_id, v_business_id, v_sale_id, p_branch_id, v_method, v_amount,
      case when v_method = 'momo' then 'pending' else 'success' end,
      case when v_method = 'momo' then 'paystack' else null end,
      case when v_method = 'momo' then v_payment_id::text else null end,
      v_pay ->> 'momo_number', v_pay ->> 'momo_network',
      case when v_method = 'momo' then null else now() end,
      auth.uid()
    );
  end loop;

  -- Nothing to wait for: complete it now, through the same function the
  -- webhook will use.
  if v_status = 'completed' then
    perform finalize_sale(v_sale_id);
  end if;

  return v_sale_id;
end;
$$;

grant execute on function create_sale(uuid, uuid, uuid, text, numeric, jsonb, jsonb) to authenticated;

comment on function create_sale(uuid, uuid, uuid, text, numeric, jsonb, jsonb) is
  'Rings up a sale in one transaction: the sale and its lines, the stock movements for product lines (never for a service line), and one row per tender. Prices, tax rates and costs are read from the database, never accepted from the caller. cashier_id is always the signed-in account (0039) — p_cashier_id may only be null or your own id. Each service-line item carries EITHER rendered_by (a profiles.id) OR provider_id (a service_providers.id, branch-scoped to this sale''s own branch) — required and validated, exactly one of the two (0045); a product line carries neither.';

-- ═══════════════════════════════════════════════════════════════════════
-- ── service_provider_performance(): unify both renderer pools ───────────
-- ═══════════════════════════════════════════════════════════════════════
--
-- DROPPED first, not just redefined — its OUTPUT column list changes
-- (first_name/last_name, which only ever made sense for a profiles row,
-- become full_name/title so a service_providers row has somewhere to put
-- its own name and job title), and Postgres refuses a CREATE OR REPLACE
-- that changes a function's return type.
drop function if exists service_provider_performance(timestamptz, timestamptz, uuid, int);

-- SECURITY INVOKER throughout, like every other reporting function in
-- Busihub (0032's own header), so RLS decides what is counted — no
-- special-cased bypass of tenant isolation for a report.
--
-- Still deliberately NOT built from staff_performance() (0030), for the
-- same reason 0041's version wasn't: that function attributes a sale's
-- FULL total to whoever the sale's cashier_id is (who rang it up). This
-- attributes each SERVICE LINE's own revenue to whoever actually
-- rendered it — from EITHER pool now — a materially different question,
-- since one sale can have a different cashier than renderer, and several
-- renderers across its lines.
create or replace function service_provider_performance(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_branch_id uuid default null,
  p_limit int default 10
)
returns table (
  renderer_type   text,   -- 'staff' (a profiles row) or 'provider' (a service_providers row)
  renderer_id     uuid,
  full_name       text,
  title           text,   -- job title/specialty — only ever set for a 'provider' row
  service_count   bigint,
  gross_total     numeric,
  refunded_total  numeric,
  net_total       numeric
)
language sql
stable
as $$
  with scoped as (
    select
      si.id,
      si.rendered_by,
      si.provider_id,
      si.line_total
    from sale_items si
    join sales s on s.id = si.sale_id
    where s.status = 'completed'
      and (si.rendered_by is not null or si.provider_id is not null)
      and (p_from is null or s.created_at >= p_from)
      and (p_to is null or s.created_at <= p_to)
      and (p_branch_id is null or s.branch_id = p_branch_id)
  ),
  -- Unify both pools onto one key: a renderer_type tag plus its own id —
  -- never comparing a profiles.id and a service_providers.id bare, since
  -- the two are different id spaces that could otherwise coincidentally
  -- collide.
  keyed as (
    select
      id,
      line_total,
      case when rendered_by is not null then 'staff' else 'provider' end as renderer_type,
      coalesce(rendered_by, provider_id) as renderer_id
    from scoped
  ),
  rendered as (
    select renderer_type, renderer_id, count(*) as lines, sum(line_total) as amount
    from keyed
    group by renderer_type, renderer_id
  ),
  -- The refund is charged to whoever rendered the original line — the
  -- question being asked here is "how much of what they did stuck?" —
  -- not to whoever pressed the refund button.
  returned as (
    select k.renderer_type, k.renderer_id, sum(ri.line_total) as amount
    from refund_items ri
    join keyed k on k.id = ri.sale_item_id
    group by k.renderer_type, k.renderer_id
  )
  select
    rendered.renderer_type,
    rendered.renderer_id,
    case
      when rendered.renderer_type = 'staff'
        then nullif(trim(both ' ' from coalesce(pr.first_name, '') || ' ' || coalesce(pr.last_name, '')), '')
      else sp.name
    end,
    sp.title,
    rendered.lines,
    rendered.amount,
    coalesce(returned.amount, 0),
    rendered.amount - coalesce(returned.amount, 0)
  from rendered
  left join returned
    on returned.renderer_type = rendered.renderer_type and returned.renderer_id = rendered.renderer_id
  left join profiles pr on rendered.renderer_type = 'staff' and pr.id = rendered.renderer_id
  left join service_providers sp on rendered.renderer_type = 'provider' and sp.id = rendered.renderer_id
  order by 8 desc
  limit least(greatest(coalesce(p_limit, 10), 1), 100);
$$;

grant execute on function service_provider_performance(timestamptz, timestamptz, uuid, int) to authenticated;

comment on function service_provider_performance(timestamptz, timestamptz, uuid, int) is
  'Per-renderer service revenue and returns over a period, from EITHER renderer pool (0045): a profiles row (renderer_type = staff) or a service_providers row (renderer_type = provider), attributed from sale_items.rendered_by/provider_id (who did the work), not sales.cashier_id (who rang it up) — see staff_performance() (0030) for the cashier-based equivalent. Runs as the caller.';