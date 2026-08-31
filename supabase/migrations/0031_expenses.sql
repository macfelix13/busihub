-- Busihub — 0031: expenses (Phase 13)
--
-- The last piece the dashboard needs before "net profit" stops being a
-- word we are careful not to use. Gross profit (0029) is sales less what
-- the goods cost. Net profit is that, less rent, wages, light, water,
-- fuel and everything else that leaves the shop — which until now Busihub
-- had nowhere to record.
--
-- THREE DECISIONS, MADE DELIBERATELY
--
-- 1. An expense counts the moment it is recorded. There is no approval
--    queue. In the shops Busihub is for, the person recording the expense
--    is usually the person who spent the money, and a queue that nobody
--    empties turns "this month's profit" into a number that is wrong
--    until someone remembers to click. `expenses.approve` therefore has
--    no approval to do, and is repurposed below as the permission for
--    the things that ARE dangerous: voiding a recorded expense and
--    changing the category list. Its catalog description is updated to
--    say so rather than left describing a workflow that does not exist.
--
-- 2. No recurring-expense machinery. Rent is typed in each month. The
--    alternative posts money into the books that nobody looked at, and a
--    profit figure containing an expense the owner did not agree to is
--    worse than one that is late.
--
-- 3. An expense records WHERE the money came from. A cashier paying the
--    water bill out of the till is the single most common reason a
--    drawer count comes up short, and a shop that cannot explain the
--    shortfall assumes theft. `cash_drawer_summary()` below closes that
--    loop: takings in, cash expenses out, what should be in the drawer.
--
-- NOTHING IS EVER DELETED. An expense that was a mistake is VOIDED —
-- status flips, it stops counting, it stays on the page with the reason
-- attached. Money records that can vanish are money records nobody can
-- audit, which is the same reasoning as sales (0021) and the inventory
-- ledger (0015).

-- ── categories ───────────────────────────────────────────────────────────
--
-- Per business, not a global list. "Chop money" and "Dumsor generator
-- fuel" are real lines in a Ghanaian shop's book and a fixed enum would
-- refuse them; a shop that cannot name its own costs stops recording
-- them.

create table expense_categories (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name        text not null check (char_length(trim(name)) > 0),
  -- Seeded by Busihub rather than typed by the shop. Kept so the seeded
  -- set can be told apart from what a shop added, and so a future
  -- migration can add a default without clobbering a rename.
  is_system   boolean not null default false,
  status      text not null default 'active' check (status in ('active', 'archived')),
  created_at  timestamptz not null default now(),
  unique (business_id, name)
);

create index expense_categories_business_idx on expense_categories (business_id, status);

comment on table expense_categories is
  'Per-business expense categories. Seeded with a starting set at registration; a shop can add its own and archive ones it does not use.';

-- ── expenses ─────────────────────────────────────────────────────────────

create table expenses (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id) on delete cascade,
  -- Which shop the money left. Required: an expense with no branch
  -- cannot be reconciled against any drawer, and "the business paid it"
  -- is not an answer when there are three branches.
  branch_id         uuid not null references branches(id) on delete restrict,
  category_id       uuid references expense_categories(id) on delete restrict,
  reference_number  text not null check (char_length(trim(reference_number)) > 0),
  description       text not null check (char_length(trim(description)) > 0),
  amount            numeric(14, 2) not null check (amount > 0),
  -- The day the money left, which is not always the day it was typed in.
  expense_date      date not null,
  paid_from         text not null check (paid_from in ('cash', 'momo', 'bank', 'other')),
  -- A momo transaction id, cheque number, or receipt number.
  payment_reference text,
  note              text,
  status            text not null default 'recorded' check (status in ('recorded', 'voided')),
  voided_by         uuid references profiles(id),
  voided_at         timestamptz,
  void_reason       text,
  recorded_by       uuid references profiles(id),
  created_at        timestamptz not null default now(),
  unique (business_id, reference_number),
  -- A voided expense must say who voided it and why. Half a void is an
  -- unexplained hole in the month's figures.
  constraint expenses_void_is_explained check (
    (status = 'recorded' and voided_at is null and voided_by is null and void_reason is null)
    or (status = 'voided' and voided_at is not null and voided_by is not null
        and char_length(trim(coalesce(void_reason, ''))) > 0)
  )
);

create index expenses_business_date_idx on expenses (business_id, expense_date desc);
create index expenses_branch_date_idx on expenses (branch_id, expense_date desc);
create index expenses_category_idx on expenses (category_id);

comment on table expenses is
  'Money that left the business. Counts against profit as soon as it is recorded; corrected by voiding, never by deleting.';
comment on column expenses.paid_from is
  'Where the money came from: the till (cash), a mobile money wallet, the bank, or elsewhere. Cash expenses are what a drawer count has to account for.';
comment on column expenses.expense_date is
  'The day the money left, which is not always the day it was typed in. Reporting groups by this, not by created_at.';

-- ── the context trigger ──────────────────────────────────────────────────
--
-- Same shape as inventory_movements (0015): business_id is DERIVED from
-- the branch, and attribution is taken from the session. Neither is ever
-- read from the payload, so a caller cannot file an expense against a
-- business they do not belong to by naming it, and cannot record one in
-- somebody else's name.

create or replace function set_expense_context()
returns trigger
language plpgsql
as $$
declare
  v_branch_business uuid;
  v_category_business uuid;
begin
  select business_id into v_branch_business from branches where id = new.branch_id;
  if v_branch_business is null then
    raise exception 'Invalid branch_id: branch not found' using errcode = 'P0002';
  end if;

  if new.category_id is not null then
    select business_id into v_category_business
    from expense_categories where id = new.category_id;
    if v_category_business is null then
      raise exception 'Invalid category_id: category not found' using errcode = 'P0002';
    end if;
    -- The lookups above are RLS-scoped (this function is SECURITY
    -- INVOKER by design), so another tenant's branch or category already
    -- reads as "not found". This catches the remaining case: someone who
    -- legitimately belongs to two businesses pairing a branch from one
    -- with a category from the other.
    if v_category_business <> v_branch_business then
      raise exception 'Branch and category belong to different businesses' using errcode = 'P0001';
    end if;
  end if;

  new.business_id := v_branch_business;
  new.recorded_by := auth.uid();

  return new;
end;
$$;

comment on function set_expense_context() is
  'Forces expenses.business_id to match the branch (and requires the category to be in that same business), and stamps recorded_by from the session. Runs BEFORE INSERT so the RLS WITH CHECK evaluates the corrected business_id, not whatever the caller sent.';

create trigger set_expense_context_trigger
  before insert on expenses
  for each row execute function set_expense_context();

-- ── row level security ───────────────────────────────────────────────────

alter table expense_categories enable row level security;

-- Anyone who may see OR record an expense needs the category list: the
-- recording form cannot be filled in without it.
create policy expense_categories_select on expense_categories
  for select
  using (
    app_has_permission(business_id, 'expenses.view')
    or app_has_permission(business_id, 'expenses.create')
    or app_is_super_admin()
  );

-- Shaping the ledger is the elevated act, not recording into it — see
-- the header on why that is 'expenses.approve'.
create policy expense_categories_insert on expense_categories
  for insert
  with check (app_has_permission(business_id, 'expenses.approve') or app_is_super_admin());

create policy expense_categories_update on expense_categories
  for update
  using (app_has_permission(business_id, 'expenses.approve') or app_is_super_admin())
  with check (app_has_permission(business_id, 'expenses.approve') or app_is_super_admin());

revoke delete on expense_categories from authenticated;

alter table expenses enable row level security;

create policy expenses_select on expenses
  for select
  using (app_has_permission(business_id, 'expenses.view') or app_is_super_admin());

create policy expenses_insert on expenses
  for insert
  with check (app_has_permission(business_id, 'expenses.create') or app_is_super_admin());

-- Update exists only so void_expense() can flip the status. A recorded
-- expense's amount, date and description are not editable: correcting
-- one means voiding it and recording the right one, which leaves both on
-- the page. An editable amount is an unauditable one.
create policy expenses_update on expenses
  for update
  using (app_has_permission(business_id, 'expenses.approve') or app_is_super_admin())
  with check (app_has_permission(business_id, 'expenses.approve') or app_is_super_admin());

revoke delete on expenses from authenticated;

-- Column-level, and TABLE-LEVEL FIRST. A table-level grant authorises
-- every column regardless of any per-column revoke, so the grant has to
-- be taken away before the narrow one is given (the same trap as
-- profiles.pin_hash in 0018). Without this, an expense's amount could be
-- edited in place through the update policy above.
revoke update on expenses from authenticated;
grant update (status, voided_by, voided_at, void_reason) on expenses to authenticated;

-- ── the permission whose meaning changed ─────────────────────────────────
--
-- No approval workflow exists, so "Approve expenses" describes something
-- Busihub does not do. The key stays (roles already reference it; every
-- Owner, Manager and Accountant holds it) and the description is
-- corrected to what it actually authorises.

update permissions
set description = 'Manage the expense ledger: void expenses, manage categories'
where key = 'expenses.approve';

-- ── starting categories ──────────────────────────────────────────────────

create or replace function seed_expense_categories(p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into expense_categories (business_id, name, is_system)
  select p_business_id, name, true
  from (values
    ('Rent'),
    ('Wages and salaries'),
    ('Electricity'),
    ('Water'),
    ('Transport and fuel'),
    ('Airtime and data'),
    ('Shop supplies'),
    ('Repairs and maintenance'),
    ('Licences and permits'),
    ('Bank and mobile money charges'),
    ('Other')
  ) as defaults(name)
  on conflict (business_id, name) do nothing;
end;
$$;

comment on function seed_expense_categories(uuid) is
  'Gives a business a starting set of expense categories. SECURITY DEFINER because it runs inside registration, before the new owner has a role to be checked against — it writes only to the business id it was given and inserts nothing else.';

revoke execute on function seed_expense_categories(uuid) from public, authenticated;

-- Every business that already exists.
do $$
declare v_business record;
begin
  for v_business in select id from businesses loop
    perform seed_expense_categories(v_business.id);
  end loop;
end $$;

-- ── recording an expense ─────────────────────────────────────────────────

create or replace function create_expense(
  p_branch_id uuid,
  p_category_id uuid,
  p_description text,
  p_amount numeric,
  p_expense_date date,
  p_paid_from text,
  p_payment_reference text default null,
  p_note text default null
)
returns uuid
language plpgsql
as $$
declare
  v_business_id uuid;
  v_next int;
  v_reference text;
  v_id uuid;
  v_date date;
begin
  select business_id into v_business_id from branches where id = p_branch_id;
  if v_business_id is null then
    raise exception 'Invalid branch_id: branch not found' using errcode = 'P0002';
  end if;

  if coalesce(p_amount, 0) <= 0 then
    raise exception 'An expense needs an amount greater than zero' using errcode = 'P0001';
  end if;
  if char_length(trim(coalesce(p_description, ''))) = 0 then
    raise exception 'Say what the money was spent on' using errcode = 'P0001';
  end if;
  if p_paid_from not in ('cash', 'momo', 'bank', 'other') then
    raise exception 'Choose where the money came from' using errcode = 'P0001';
  end if;

  v_date := coalesce(p_expense_date, current_date);
  -- An expense is money that has already left. Allowing a future date
  -- would let this month's figures be moved into next month's by typing
  -- a different day, which is the easiest possible way to make a bad
  -- month look good.
  if v_date > current_date then
    raise exception 'An expense cannot be dated in the future' using errcode = 'P0001';
  end if;

  -- Reference numbers, serialised per business so two people recording
  -- at once cannot both claim EX-000042.
  perform pg_advisory_xact_lock(hashtextextended('expense:' || v_business_id::text, 0));

  select coalesce(max((substring(reference_number from '^EX-([0-9]+)$'))::int), 0) + 1
  into v_next
  from expenses
  where business_id = v_business_id and reference_number ~ '^EX-[0-9]+$';

  v_reference := 'EX-' || lpad(v_next::text, 6, '0');

  -- business_id and recorded_by are overwritten by the BEFORE trigger;
  -- the values here are placeholders the trigger replaces, and the RLS
  -- WITH CHECK then runs against the corrected business_id.
  insert into expenses (
    business_id, branch_id, category_id, reference_number, description,
    amount, expense_date, paid_from, payment_reference, note
  )
  values (
    v_business_id, p_branch_id, p_category_id, v_reference, trim(p_description),
    round(p_amount, 2), v_date, p_paid_from,
    nullif(trim(coalesce(p_payment_reference, '')), ''),
    nullif(trim(coalesce(p_note, '')), '')
  )
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function create_expense(uuid, uuid, text, numeric, date, text, text, text) to authenticated;

comment on function create_expense(uuid, uuid, text, numeric, date, text, text, text) is
  'Records an expense against a branch. The business is derived from the branch and the person from the session, so neither can be supplied by a caller. Refuses a future date, a zero amount, and a blank description. Runs as the caller, so the RLS insert policy decides whether it is allowed.';

-- ── voiding one ──────────────────────────────────────────────────────────

create or replace function void_expense(p_expense_id uuid, p_reason text)
returns void
language plpgsql
as $$
declare v_expense record;
begin
  if char_length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Say why this expense is being voided' using errcode = 'P0001';
  end if;

  -- Read under the caller's own RLS: an expense they cannot see is an
  -- expense they cannot void, and it reads as "not found" rather than
  -- confirming that a row with that id exists somewhere.
  select * into v_expense from expenses where id = p_expense_id;
  if v_expense.id is null then
    raise exception 'Expense not found' using errcode = 'P0002';
  end if;
  if v_expense.status = 'voided' then
    raise exception 'This expense has already been voided' using errcode = 'P0001';
  end if;

  update expenses
  set status = 'voided',
      voided_by = auth.uid(),
      voided_at = now(),
      void_reason = trim(p_reason)
  where id = p_expense_id and status = 'recorded';

  -- An RLS-denied UPDATE does not raise; it matches nothing. Without
  -- this check the function would return quietly and the caller would
  -- believe the expense was voided.
  if not found then
    raise exception 'Missing permission: expenses.approve' using errcode = '42501';
  end if;
end;
$$;

grant execute on function void_expense(uuid, text) to authenticated;

comment on function void_expense(uuid, text) is
  'Voids a recorded expense with a reason, so it stops counting against profit but stays on the page. Raises rather than returning quietly if RLS refused the update.';

-- ── what it all came to ──────────────────────────────────────────────────
--
-- Dates, not timestamps: an expense is recorded against the day the money
-- left, and p_to is INCLUSIVE, because "1 August to 31 August" is what a
-- person means by August. Voided expenses are excluded everywhere.
--
-- SECURITY INVOKER, like every other reporting function in Busihub, so
-- RLS scopes the total to the caller's own business.

create or replace function expense_summary(
  p_from date default null,
  p_to date default null,
  p_branch_id uuid default null
)
returns table (
  expense_total numeric,
  expense_count bigint,
  cash_paid_out numeric
)
language sql
stable
as $$
  select
    coalesce(sum(e.amount), 0),
    count(*)::bigint,
    coalesce(sum(e.amount) filter (where e.paid_from = 'cash'), 0)
  from expenses e
  where e.status = 'recorded'
    and (p_from is null or e.expense_date >= p_from)
    and (p_to is null or e.expense_date <= p_to)
    and (p_branch_id is null or e.branch_id = p_branch_id);
$$;

grant execute on function expense_summary(date, date, uuid) to authenticated;

comment on function expense_summary(date, date, uuid) is
  'Total expenses over a period, with the cash portion separated out because that is what a drawer count has to account for. Voided expenses excluded. Runs as the caller.';

create or replace function expenses_by_category(
  p_from date default null,
  p_to date default null,
  p_branch_id uuid default null,
  p_limit int default 10
)
returns table (
  category_id uuid,
  category_name text,
  amount numeric,
  expense_count bigint
)
language sql
stable
as $$
  select
    e.category_id,
    -- An expense recorded before a category was archived, or with none
    -- chosen, still has to appear: dropping it would make the parts stop
    -- summing to the whole.
    coalesce(c.name, 'Uncategorised'),
    sum(e.amount),
    count(*)::bigint
  from expenses e
  left join expense_categories c on c.id = e.category_id
  where e.status = 'recorded'
    and (p_from is null or e.expense_date >= p_from)
    and (p_to is null or e.expense_date <= p_to)
    and (p_branch_id is null or e.branch_id = p_branch_id)
  group by e.category_id, c.name
  order by 3 desc
  limit least(greatest(coalesce(p_limit, 10), 1), 100);
$$;

grant execute on function expenses_by_category(date, date, uuid, int) to authenticated;

comment on function expenses_by_category(date, date, uuid, int) is
  'Where the money went, biggest first. Expenses with no category are grouped as Uncategorised rather than dropped, so the parts still sum to the whole. Runs as the caller.';

-- ── the drawer ───────────────────────────────────────────────────────────
--
-- The reason paid_from exists. A cashier who pays the water bill out of
-- the till leaves the count short by exactly that amount, and a shop that
-- cannot explain a shortfall assumes theft. This says what SHOULD be in
-- the drawer.
--
-- Cash taken is net of change given, for the same reason
-- payment_method_breakdown is (0030): the tender row records what was
-- handed over, and the change went straight back.
--
-- It takes a timestamp range for the takings and a date range for the
-- expenses, because that is what each side actually is — a sale happens
-- at a moment, an expense is booked to a day.

create or replace function cash_drawer_summary(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_from_date date default null,
  p_to_date date default null,
  p_branch_id uuid default null
)
returns table (
  cash_taken numeric,
  cash_paid_out numeric,
  expected_in_drawer numeric
)
language sql
stable
as $$
  with taken as (
    select coalesce(sum(sp.amount - coalesce(s.change_given, 0)), 0) as amount
    from sale_payments sp
    join sales s on s.id = sp.sale_id
    where sp.status = 'success'
      and sp.method = 'cash'
      and s.status = 'completed'
      and (p_from is null or sp.created_at >= p_from)
      and (p_to is null or sp.created_at <= p_to)
      and (p_branch_id is null or sp.branch_id = p_branch_id)
  ),
  paid as (
    select coalesce(sum(e.amount), 0) as amount
    from expenses e
    where e.status = 'recorded'
      and e.paid_from = 'cash'
      and (p_from_date is null or e.expense_date >= p_from_date)
      and (p_to_date is null or e.expense_date <= p_to_date)
      and (p_branch_id is null or e.branch_id = p_branch_id)
  )
  select
    (select amount from taken),
    (select amount from paid),
    (select amount from taken) - (select amount from paid);
$$;

grant execute on function cash_drawer_summary(timestamptz, timestamptz, date, date, uuid) to authenticated;

comment on function cash_drawer_summary(timestamptz, timestamptz, date, date, uuid) is
  'What should be in the till: cash taken (net of change given) less cash expenses paid out of it. Runs as the caller.';

-- ── new businesses get the starting categories too ───────────────────────
--
-- A trigger rather than an extra line inside register_business(). The
-- roles seeder there is ninety lines of permission lists, and copying it
-- forward to append one call is how the copy and the original quietly
-- drift apart. This hangs off the businesses table instead, so every
-- route that creates a business — registration today, an import or an
-- admin tool later — gets the categories without anyone remembering to
-- add the call.

create or replace function seed_expense_categories_for_new_business()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform seed_expense_categories(new.id);
  return new;
end;
$$;

comment on function seed_expense_categories_for_new_business() is
  'Gives every newly created business the starting expense categories. SECURITY DEFINER because it fires during registration, before the owner has a role for RLS to check against.';

create trigger seed_expense_categories_trigger
  after insert on businesses
  for each row execute function seed_expense_categories_for_new_business();