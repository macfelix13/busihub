-- Busihub — 0017: customers & credit accounts (Phase 8)
--
-- Two things, deliberately coupled: who the shop sells to, and what they
-- owe. Buying on credit and settling later ("book" sales) is ordinary in
-- this market and is the main reason a small shop keeps customer records
-- at all, so a contact list without balances would be half a feature.
--
-- The balance follows the same rule as stock (0015): it is NEVER edited
-- directly. Every change is an append-only customer_account_entries row,
-- and customer_balances is a derived aggregate a trigger maintains in the
-- same transaction. "Why does Ama owe 240?" is always answerable.
--
-- Sign convention, fixed once here so nothing has to guess: amount is
-- positive when the customer owes MORE (a charge), negative when they owe
-- LESS (a payment). balance > 0 therefore means "owes the business".
--
-- Permission model (both already in the 0010 catalog and assigned in
-- 0011 — no catalog change):
--   customers.view — read customers, their entries and balances.
--   customers.edit — create/edit/archive a customer, and record account
--                    entries (charges, payments, corrections).
--
-- NOTE on who may set a credit limit: customers.edit covers the whole
-- record, credit_limit included, and the seeded Cashier role holds
-- customers.edit — because a cashier legitimately needs to add a walk-in
-- customer at the till. So by default a cashier can also raise a credit
-- limit. There is no permission in the catalog that cleanly separates
-- "add a customer" from "decide how much credit to extend", and inventing
-- one mid-project would leave every existing business without it. A shop
-- that wants that split removes customers.edit from Cashier. Flagged
-- rather than silently designed around, same as the Inventory Manager /
-- purchase_orders.approve overlap noted in 0016.

-- ── phone normalization ──────────────────────────────────────────────────
--
-- "One record per phone number" is only a real guarantee if 024 412 3456,
-- 0244123456 and +233244123456 collide. Formatting is stripped, and the
-- two Ghanaian ways of writing the same mobile number are folded onto the
-- local 0-prefixed form. Anything that doesn't match those shapes keeps
-- its digits unchanged rather than being mangled into a false match.
create or replace function normalize_phone(p_phone text)
returns text
language sql
immutable
as $$
  select case
    when s.digits = '' then null
    -- +233 24 412 3456 / 233244123456 -> 0244123456
    when length(s.digits) = 12 and left(s.digits, 3) = '233' then '0' || right(s.digits, 9)
    -- 244123456 (leading zero dropped, as phones often are) -> 0244123456
    when length(s.digits) = 9 then '0' || s.digits
    else s.digits
  end
  from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as digits) s;
$$;

comment on function normalize_phone(text) is
  'Folds the ways one Ghanaian mobile number gets written onto a single form, so the uniqueness rule on customers.phone actually holds. IMMUTABLE because a generated column depends on it.';

-- ── customers ────────────────────────────────────────────────────────────

create table customers (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  name         text not null check (char_length(trim(name)) > 0),
  -- Stored as the user typed it; matched on the normalized form below.
  phone        text,
  phone_key    text generated always as (normalize_phone(phone)) stored,
  email        citext,
  address      text,
  notes        text,
  -- The most this customer may owe. 0 (the default) means no credit:
  -- they pay at the till. Enforced by apply_customer_account_entry()
  -- below, not merely displayed — an unenforced limit is not a limit.
  credit_limit numeric(14, 2) not null default 0 check (credit_limit >= 0),
  status       text not null default 'active' check (status in ('active', 'archived')),
  created_by   uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index customers_business_id_idx on customers (business_id);
create index customers_business_name_idx on customers (business_id, name);

-- Phone is optional, but a phone that IS given identifies exactly one
-- customer in the business — otherwise a balance ends up split across two
-- records for the same person and reconciles to nothing.
create unique index customers_business_phone_key_idx
  on customers (business_id, phone_key)
  where phone_key is not null;

create trigger set_updated_at
  before update on customers
  for each row execute function set_updated_at();

comment on table customers is
  'Who the business sells to. Archived rather than deleted — a sale or an account entry must still resolve its customer.';

-- ── the account ledger (append-only) ─────────────────────────────────────

create table customer_account_entries (
  id             uuid primary key default gen_random_uuid(),
  -- Denormalized from the customer by the trigger below (never trusted
  -- from the caller), same rationale as inventory_movements (0015).
  business_id    uuid not null references businesses(id) on delete cascade,
  customer_id    uuid not null references customers(id) on delete restrict,
  -- Where it happened. Nullable: a payment can be taken anywhere, and
  -- earlier phases have no branch context to insist on.
  branch_id      uuid references branches(id) on delete restrict,
  -- Signed. Positive = the customer owes more; negative = owes less.
  amount         numeric(14, 2) not null check (amount <> 0),
  entry_type     text not null check (entry_type in (
                   -- insertable in this phase:
                   'charge', 'payment', 'adjustment',
                   -- reserved for later phases; no RLS policy admits them
                   -- yet, so an insert claiming one is rejected:
                   'sale', 'refund'
                 )),
  reference_type text,
  reference_id   uuid,
  note           text,
  created_by     uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now()
);

-- No updated_at: rows here are immutable. Enforced by the absent
-- update/delete policies AND the revoked grants further down.

create index customer_account_entries_customer_created_idx
  on customer_account_entries (customer_id, created_at desc);
create index customer_account_entries_business_created_idx
  on customer_account_entries (business_id, created_at desc);

comment on table customer_account_entries is
  'Append-only ledger of everything a customer has been charged and has paid. Never updated or deleted — a correction is a new entry. customer_balances is derived from this.';

-- ── derived balance ──────────────────────────────────────────────────────

create table customer_balances (
  customer_id uuid primary key references customers(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  balance     numeric(14, 2) not null default 0,
  updated_at  timestamptz not null default now()
);

create index customer_balances_business_idx on customer_balances (business_id);

comment on table customer_balances is
  'Derived aggregate — what one customer currently owes (positive) or is in credit by (negative). Written ONLY by apply_customer_account_entry(); users hold no write grant on this table at all.';

-- ── tenancy forcing ──────────────────────────────────────────────────────

create or replace function set_customer_account_entry_context()
returns trigger
language plpgsql
as $$
declare
  v_customer_business uuid;
  v_branch_business   uuid;
begin
  select business_id into v_customer_business from customers where id = new.customer_id;
  if v_customer_business is null then
    raise exception 'Invalid customer_id: customer not found' using errcode = 'P0002';
  end if;

  if new.branch_id is not null then
    select business_id into v_branch_business from branches where id = new.branch_id;
    if v_branch_business is null then
      raise exception 'Invalid branch_id: branch not found' using errcode = 'P0002';
    end if;
    if v_branch_business <> v_customer_business then
      raise exception 'Customer and branch belong to different businesses' using errcode = 'P0001';
    end if;
  end if;

  new.business_id := v_customer_business;
  new.created_by := auth.uid();

  return new;
end;
$$;

create trigger set_entry_context
  before insert on customer_account_entries
  for each row execute function set_customer_account_entry_context();

-- ── the derived-aggregate trigger ────────────────────────────────────────

create or replace function apply_customer_account_entry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new_balance  numeric(14, 2);
  v_credit_limit numeric(14, 2);
begin
  -- One atomic statement; the ON CONFLICT path row-locks the balance for
  -- the rest of the transaction, so two concurrent entries against the
  -- same customer serialize instead of both reading the same "before"
  -- value. Same reasoning as apply_inventory_movement() in 0015.
  insert into customer_balances (customer_id, business_id, balance, updated_at)
  values (new.customer_id, new.business_id, new.amount, now())
  on conflict (customer_id) do update
    set balance    = customer_balances.balance + excluded.balance,
        updated_at = now()
  returning balance into v_new_balance;

  -- A limit is only a limit if something refuses to cross it. Checked
  -- after the fact against the resulting balance so partial payments and
  -- corrections are always allowed through — only a move that leaves the
  -- customer owing more than permitted is rejected.
  if new.amount > 0 then
    select credit_limit into v_credit_limit from customers where id = new.customer_id;
    if v_new_balance > v_credit_limit then
      raise exception 'This would put % over their credit limit (balance %, limit %)',
        (select name from customers where id = new.customer_id), v_new_balance, v_credit_limit
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

comment on function apply_customer_account_entry() is
  'AFTER INSERT on customer_account_entries: applies the amount to customer_balances in the same transaction and enforces the credit limit. SECURITY DEFINER because customer_balances grants users no write access — this is its only writer.';

create trigger apply_entry
  after insert on customer_account_entries
  for each row execute function apply_customer_account_entry();

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table customers enable row level security;

create policy customers_select on customers
  for select
  using (app_has_permission(business_id, 'customers.view') or app_is_super_admin());

create policy customers_insert on customers
  for insert
  with check (app_has_permission(business_id, 'customers.edit') or app_is_super_admin());

create policy customers_update on customers
  for update
  using (app_has_permission(business_id, 'customers.edit') or app_is_super_admin())
  with check (app_has_permission(business_id, 'customers.edit') or app_is_super_admin());

-- No delete policy: archive instead (entries reference the customer).

alter table customer_account_entries enable row level security;

create policy customer_account_entries_select on customer_account_entries
  for select
  using (app_has_permission(business_id, 'customers.view') or app_is_super_admin());

-- Per entry_type, so the kinds reserved for later phases ('sale',
-- 'refund') match no branch here and are rejected until the phase that
-- generates them adds its own policy.
create policy customer_account_entries_insert on customer_account_entries
  for insert
  with check (
    app_is_super_admin()
    or (entry_type in ('charge', 'payment', 'adjustment')
        and app_has_permission(business_id, 'customers.edit'))
  );

-- Append-only: no update/delete policy, and the grants withdrawn so the
-- statement is refused outright rather than merely filtered.
revoke update, delete on customer_account_entries from authenticated;

alter table customer_balances enable row level security;

create policy customer_balances_select on customer_balances
  for select
  using (app_has_permission(business_id, 'customers.view') or app_is_super_admin());

-- Derived state: no write policy, and no write grant. The only writer is
-- apply_customer_account_entry(), which is SECURITY DEFINER.
revoke insert, update, delete on customer_balances from authenticated;

-- ── record_customer_payment(): the common case, made safe ────────────────
--
-- Payments are entered as a positive amount ("Ama paid 50") and stored as
-- a negative one, so the sign convention is settled in exactly one place
-- rather than in every caller. A payment larger than the balance is
-- allowed — that is a customer in credit, which is a real situation — but
-- a zero or negative "payment" is not.
create or replace function record_customer_payment(
  p_customer_id uuid,
  p_amount numeric,
  p_branch_id uuid default null,
  p_note text default null
)
returns uuid
language plpgsql
as $$
declare
  v_entry_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'A payment must be more than zero' using errcode = '22023';
  end if;

  insert into customer_account_entries (business_id, customer_id, branch_id, amount, entry_type, note)
  values (
    -- overwritten by set_customer_account_entry_context(); a non-null
    -- placeholder only satisfies NOT NULL until that trigger runs.
    '00000000-0000-0000-0000-000000000000',
    p_customer_id, p_branch_id, -p_amount, 'payment', nullif(p_note, '')
  )
  returning id into v_entry_id;

  return v_entry_id;
end;
$$;

grant execute on function record_customer_payment(uuid, numeric, uuid, text) to authenticated;

comment on function record_customer_payment(uuid, numeric, uuid, text) is
  'Records a customer payment from a positive amount, storing it as a negative ledger entry so the sign convention lives in one place.';
