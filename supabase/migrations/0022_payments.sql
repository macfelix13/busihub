-- Busihub — 0022: payments (Phase 10)
--
-- Until now a sale was paid one way, instantly: cash in the drawer, or
-- straight onto the customer's account. Mobile money is neither. The
-- customer approves a prompt on their own phone, and the answer arrives
-- seconds later on a webhook from Paystack — or never arrives at all.
-- Two things follow, and they are what this migration is about.
--
-- ONE: a sale can now have MANY payments. "GHS 50 cash and the rest on
-- momo" is ordinary in a Ghanaian shop, and a single payment_method
-- column cannot express it. Payments become their own append-only rows,
-- and sales.payment_method becomes a summary of them.
--
-- TWO: a sale now has a lifetime. It is rung up, it waits for the money,
-- and only then is it complete:
--
--     awaiting_payment ──(money lands)──> completed ──(mistake)──> voided
--            │
--            └──────(never lands)───────> cancelled
--
-- The goods leave the shelf at the START of that, not the end. This is
-- deliberate and it is the most important decision in this file. If stock
-- only moved on completion, two tills could both promise the last bag of
-- rice, and the second customer would have PAID before we discovered it
-- was gone — the one outcome a shop cannot recover from. Committing the
-- stock when the cart is rung up means a payment that succeeds can always
-- be honoured, and the only thing we have to handle is the easy case: a
-- payment that fails, which puts the goods straight back.
--
-- WHAT IS NOT HERE, deliberately:
--   * Mixing credit with anything else. A sale is either on account or
--     paid now. Part-paying an on-account sale at the counter is a
--     payment against the account (0017 already does that), not a second
--     tender, and allowing it here would mean re-checking a credit limit
--     at settlement time — minutes after the customer has walked out.
--   * Card and bank transfer. The ledger below carries them without a
--     migration when they are wanted; momo is what shops actually use.

-- ── the reason stock comes back when a payment never lands ──────────────
--
-- Distinct from 'sale_refund': nothing was ever paid and nothing is being
-- given back. Reports have to be able to tell "the customer returned it"
-- from "the momo prompt timed out", because only one of them is a return.

alter table inventory_movements drop constraint inventory_movements_reason_check;

alter table inventory_movements add constraint inventory_movements_reason_check
  check (reason in (
    'receive', 'adjustment', 'stock_count',
    'sale', 'sale_refund', 'sale_cancelled',
    -- still reserved; no policy admits them yet:
    'transfer_in', 'transfer_out'
  ));

-- Cancelling a sale you rang up is part of ringing it up, so this is
-- sales.process — not sales.void, which is for undoing a sale that was
-- actually paid for.
create policy inventory_movements_insert_cancel on inventory_movements
  for insert
  with check (reason = 'sale_cancelled' and app_has_permission(business_id, 'sales.process'));

-- ── the sale lifecycle ──────────────────────────────────────────────────

alter table sales drop constraint sales_status_check;
alter table sales add constraint sales_status_check
  check (status in ('awaiting_payment', 'completed', 'voided', 'cancelled'));

alter table sales drop constraint sales_payment_method_check;
alter table sales add constraint sales_payment_method_check
  check (payment_method in ('cash', 'credit', 'momo', 'split'));

comment on column sales.payment_method is
  'A summary of sale_payments: cash, momo or credit when there is one tender, split when the sale was settled by more than one. The payments themselves are the record.';

comment on column sales.status is
  'awaiting_payment -> completed -> voided, or awaiting_payment -> cancelled. Never edited directly: settle_sale_payment(), cancel_unpaid_sale() and void_sale() are the only ways through, and each checks its own permission.';

-- ── how a shop connects its own Paystack account ────────────────────────
--
-- Each business collects into its OWN Paystack account, so Busihub never
-- holds anyone's money. That means storing that shop's secret key, which
-- is the single most dangerous value in this schema: it can move real
-- money out of a real account.
--
-- It is stored ENCRYPTED — AES-256-GCM, in the application, under a key
-- that lives only in the server's environment (PAYSTACK_KEY_ENCRYPTION_KEY)
-- and is never written to the database. A dump of this table, on its own,
-- decrypts to nothing. The ciphertext column is additionally unreadable
-- by `authenticated` at all, by the revoke-then-grant-per-column pattern
-- 0018 established: an owner configuring their own shop can see the last
-- four characters, enough to recognise which key is installed, and never
-- the key itself.

create table business_payment_settings (
  business_id           uuid primary key references businesses(id) on delete cascade,
  -- Public key: safe to read, used only to identify the account.
  paystack_public_key   text,
  -- AES-256-GCM ciphertext of the secret key. See above.
  paystack_secret_cipher text,
  -- So a person can tell which key is installed without seeing it.
  paystack_secret_last4 text,
  -- Live vs test keys, taken from the key prefix rather than trusted from
  -- a checkbox, so a shop cannot think it is live while it is not.
  is_live               boolean not null default false,
  momo_enabled          boolean not null default false,
  configured_at         timestamptz,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references profiles(id) on delete set null
);

create trigger set_updated_at
  before update on business_payment_settings
  for each row execute function set_updated_at();

comment on table business_payment_settings is
  'One row per business holding that shop''s own Paystack credentials. The secret key is stored only as application-encrypted ciphertext and is never selectable by an ordinary user.';

alter table business_payment_settings enable row level security;

create policy business_payment_settings_select on business_payment_settings
  for select
  using (app_has_permission(business_id, 'business.manage') or app_is_super_admin());

create policy business_payment_settings_insert on business_payment_settings
  for insert
  with check (app_has_permission(business_id, 'business.manage') or app_is_super_admin());

create policy business_payment_settings_update on business_payment_settings
  for update
  using (app_has_permission(business_id, 'business.manage') or app_is_super_admin())
  with check (app_has_permission(business_id, 'business.manage') or app_is_super_admin());

-- The table-level revoke MUST come first. A table-level grant authorises
-- every column regardless of any column-level revoke — that is how the
-- pin_hash leak in 0018 happened, and the same mistake here would expose
-- a key that moves money.
revoke select, insert, update, delete on business_payment_settings from authenticated, anon;

grant select (
  business_id, paystack_public_key,
  -- paystack_secret_cipher deliberately absent. The server reads it with
  -- the service-role client; nobody else reads it at all.
  paystack_secret_last4, is_live, momo_enabled,
  configured_at, updated_at, updated_by
) on business_payment_settings to authenticated;

grant insert (
  business_id, paystack_public_key, paystack_secret_cipher,
  paystack_secret_last4, is_live, momo_enabled, configured_at, updated_by
) on business_payment_settings to authenticated;

grant update (
  paystack_public_key, paystack_secret_cipher,
  paystack_secret_last4, is_live, momo_enabled, configured_at, updated_by
) on business_payment_settings to authenticated;

-- MAINTENANCE NOTE — as with profiles in 0018: any future migration that
-- adds a column to this table must add it to the grants above, or it will
-- be invisible and unwritable. That is the price of column-level grants,
-- and it is worth paying for a table holding a payment secret.

-- ── the payments ledger ─────────────────────────────────────────────────

create table sale_payments (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id) on delete cascade,
  sale_id        uuid not null references sales(id) on delete restrict,
  branch_id      uuid not null references branches(id) on delete restrict,
  method         text not null check (method in ('cash', 'momo', 'credit')),
  -- What this tender is for. For cash this is what the customer handed
  -- over, which may exceed the sale (the difference is change_given on
  -- the sale); for momo it is exactly what Paystack is asked to charge.
  amount         numeric(14, 2) not null check (amount > 0),
  status         text not null check (status in ('pending', 'success', 'failed', 'cancelled')),
  -- Cash and credit are settled the moment they are recorded; only momo
  -- is ever pending, and only momo carries the fields below.
  provider       text check (provider in ('paystack')),
  -- The reference we send to Paystack and match the webhook back on. It
  -- is this row's own id, so it is unique by construction.
  provider_reference text,
  provider_charge_id text,
  momo_number    text,
  momo_network   text check (momo_network in ('mtn', 'vod', 'atl')),
  failure_reason text,
  settled_at     timestamptz,
  created_by     uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  -- One Paystack transaction can only ever settle one payment row.
  unique (business_id, provider_reference)
);

create index sale_payments_sale_idx on sale_payments (sale_id);
create index sale_payments_pending_idx on sale_payments (business_id, status) where status = 'pending';

comment on table sale_payments is
  'Append-only: every tender against a sale, including the ones that failed. A sale is complete when its payments cover its total. Rows are never deleted — a failed momo attempt is part of the story of that sale.';

alter table sale_payments enable row level security;

create policy sale_payments_select on sale_payments
  for select
  using (
    app_has_permission(business_id, 'sales.process')
    or app_has_permission(business_id, 'reports.view')
    or app_is_super_admin()
  );

-- Written only by create_sale(), which runs as the caller, so this is the
-- policy that actually authorises a payment row.
create policy sale_payments_insert on sale_payments
  for insert
  with check (app_has_permission(business_id, 'sales.process') or app_is_super_admin());

-- Settlement is not something a browser does. It happens on our server,
-- from a verified Paystack webhook or a server-side verify call, through
-- settle_sale_payment() below.
revoke update, delete on sale_payments from authenticated, anon;

-- ── webhook replay protection ───────────────────────────────────────────
--
-- Paystack retries a webhook every 3 minutes for 4 attempts and then
-- hourly for 72 hours until it gets a 200, so the SAME event will arrive
-- more than once as a matter of routine. Settling twice would be
-- harmless today (the status transition is idempotent) but that is a
-- property of the current code, not a guarantee — so the event id is
-- recorded and a repeat is dropped before it reaches any logic.

create table paystack_events (
  id           text primary key,
  business_id  uuid references businesses(id) on delete set null,
  event_type   text not null,
  payload      jsonb not null,
  received_at  timestamptz not null default now()
);

comment on table paystack_events is
  'Every webhook event we have accepted, keyed by Paystack''s own event id, so a retry of one we already handled is dropped rather than replayed.';

alter table paystack_events enable row level security;
-- Service role only: no policy, and no grants. Nothing an ordinary user
-- does should ever read or write this.
revoke all on paystack_events from authenticated, anon;

-- ── finalising a sale ───────────────────────────────────────────────────
--
-- The work that used to sit at the end of create_sale, lifted out so that
-- BOTH paths through the lifecycle run exactly the same code: a cash sale
-- that completes immediately, and a momo sale that completes ten seconds
-- later when the webhook lands. Two copies of this would drift, and the
-- one that drifted would be the one nobody watches.

create or replace function finalize_sale(p_sale_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale sales%rowtype;
  v_paid numeric(14, 2);
begin
  select * into v_sale from sales where id = p_sale_id;
  if v_sale.id is null then
    raise exception 'Sale not found' using errcode = 'P0002';
  end if;
  if v_sale.status = 'completed' then
    return; -- already done; settling twice must not charge twice
  end if;
  if v_sale.status <> 'awaiting_payment' then
    raise exception 'A % sale cannot be completed', v_sale.status using errcode = 'P0001';
  end if;

  -- This function runs as its owner, so RLS does not stand between a
  -- caller and someone else's sale. Two checks stand there instead.
  --
  -- First: is it actually paid? Recomputed from the ledger every time,
  -- which is what makes the function safe to hand to `authenticated` at
  -- all — the worst a caller can do with it is complete a sale that the
  -- money has already arrived for.
  select coalesce(sum(amount), 0) - v_sale.change_given into v_paid
  from sale_payments
  where sale_id = p_sale_id and status = 'success';

  if v_paid < v_sale.total then
    raise exception 'This sale has not been paid for' using errcode = 'P0001';
  end if;

  -- Second: a person doing this needs to be allowed to. There is no
  -- person on the webhook path — the money landing is not something
  -- anyone does — so the check applies only when there is a session.
  if auth.uid() is not null
     and not (app_has_permission(v_sale.business_id, 'sales.process') or app_is_super_admin()) then
    raise exception 'Missing permission: sales.process' using errcode = '42501';
  end if;

  -- Tells enforce_sale_status_rules() that this transition came from
  -- here, rather than from someone reaching for the status column. Scoped
  -- to the transaction (the `true`), so it cannot leak into the next one.
  perform set_config('busihub.settling_sale', p_sale_id::text, true);

  update sales set status = 'completed' where id = p_sale_id;

  -- On account: the balance moves through the customer ledger, and 0017's
  -- credit-limit check applies. A credit sale is never mixed with another
  -- tender (create_sale refuses it), so this is always the whole total.
  if v_sale.payment_method = 'credit' then
    insert into customer_account_entries (
      business_id, customer_id, branch_id, amount, entry_type, reference_type, reference_id, note
    )
    values (
      v_sale.business_id, v_sale.customer_id, v_sale.branch_id, v_sale.total,
      'sale', 'sale', v_sale.id, 'Sale ' || v_sale.receipt_number
    );
  end if;

  perform set_config('busihub.settling_sale', '', true);
end;
$$;

comment on function finalize_sale(uuid) is
  'Completes a sale whose money has landed: flips the status and, for an on-account sale, charges the customer ledger. Called by create_sale for an instantly-paid sale and by settle_sale_payment when a momo charge succeeds, so both take the same path.';

-- Granted, because create_sale runs as the caller and has to be able to
-- call this. That is only safe because of the two checks above; without
-- the paid-in-full test this grant would let a cashier complete a sale
-- nobody paid for.
revoke all on function finalize_sale(uuid) from public, anon;
grant execute on function finalize_sale(uuid) to authenticated, service_role;

-- ── the status transition rules, extended for the lifecycle ─────────────

create or replace function enforce_sale_status_rules()
returns trigger
language plpgsql
as $$
declare
  v_settling text := coalesce(current_setting('busihub.settling_sale', true), '');
begin
  if new.status is distinct from old.status then
    if old.status = 'awaiting_payment' and new.status = 'completed' then
      -- Only finalize_sale() may do this, and it announces itself. There
      -- is no permission check here on purpose: the money landing is not
      -- something a person does, and the webhook that reports it has no
      -- user attached at all.
      if v_settling <> new.id::text then
        raise exception 'A sale is completed by settling its payments, not by writing its status'
          using errcode = 'P0001';
      end if;

    elsif old.status = 'awaiting_payment' and new.status = 'cancelled' then
      if not (app_has_permission(new.business_id, 'sales.process') or app_is_super_admin()) then
        raise exception 'Missing permission: sales.process' using errcode = '42501';
      end if;

    elsif old.status = 'completed' and new.status = 'voided' then
      if not (app_has_permission(new.business_id, 'sales.void') or app_is_super_admin()) then
        raise exception 'Missing permission: sales.void' using errcode = '42501';
      end if;

    else
      raise exception 'A sale cannot go from % to %', old.status, new.status using errcode = 'P0001';
    end if;
  end if;

  -- Everything else about a sale stays frozen, whatever its status.
  if (new.total, new.subtotal, new.tax_total, new.receipt_number, new.customer_id,
      new.branch_id, new.payment_method, new.cashier_id)
     is distinct from
     (old.total, old.subtotal, old.tax_total, old.receipt_number, old.customer_id,
      old.branch_id, old.payment_method, old.cashier_id) then
    raise exception 'A sale cannot be edited' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- Cancelling needs the status column too, and the trigger above is what
-- decides which transition each permission may make.
drop policy sales_update_status on sales;

create policy sales_update_status on sales
  for update
  using (
    app_has_permission(business_id, 'sales.void')
    or app_has_permission(business_id, 'sales.process')
    or app_is_super_admin()
  )
  with check (
    app_has_permission(business_id, 'sales.void')
    or app_has_permission(business_id, 'sales.process')
    or app_is_super_admin()
  );

-- ── ringing up a sale, with one or more tenders ─────────────────────────
--
-- DROPPED, not replaced. Adding an argument to a Postgres function does
-- not redefine it — it creates a second function alongside the first, and
-- every existing six-argument call would keep resolving to the old one.
-- The old body would then still write sales straight to 'completed' with
-- no payment rows at all, and nothing would look wrong until the numbers
-- were reconciled.
drop function if exists create_sale(uuid, uuid, uuid, text, numeric, jsonb);

create or replace function create_sale(
  p_branch_id uuid,
  p_cashier_id uuid,
  p_customer_id uuid,
  p_payment_method text,
  p_amount_tendered numeric,
  p_items jsonb,                  -- [{variant_id, quantity}]
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
  v_next          int;
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
  v_summary       text;
  v_status        text;
  v_payment_id    uuid;
begin
  if p_items is null or jsonb_array_length(p_items) < 1 then
    raise exception 'A sale needs at least one item' using errcode = 'P0001';
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

  if p_cashier_id is not null then
    if not exists (
      select 1 from profiles
      where id = p_cashier_id and business_id = v_business_id and status = 'active'
    ) then
      raise exception 'Invalid cashier' using errcode = 'P0002';
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
    elsif v_method = 'credit' and (v_pay -> 'amount') is null then
      -- "The whole total", filled in once the lines are priced.
      v_credit_is_total := true;
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
  -- (Unchanged from 0020 — the sale row is still inserted once, already
  -- correct, because `sales` grants UPDATE on nothing but status.)
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every line needs a quantity greater than zero' using errcode = 'P0001';
    end if;

    select v.id, v.sku, v.selling_price, v.status, p.name, p.tax_category
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
      'tax_category', v_variant.tax_category,
      'line_subtotal', v_line_subtotal,
      'line_tax', v_line_tax,
      'line_total', v_gross
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

  -- ── does the money add up? ────────────────────────────────────────────
  --
  -- Everything that is not cash must be exact: you cannot overcharge a
  -- momo prompt and hand back the difference, and an account sale is the
  -- total by definition. Cash is the only tender that may exceed, and the
  -- excess is the change in the drawer.
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

  select coalesce(max((substring(receipt_number from '^R-([0-9]+)$'))::int), 0) + 1
  into v_next
  from sales
  where business_id = v_business_id and receipt_number ~ '^R-[0-9]+$';

  v_reference := 'R-' || lpad(v_next::text, 6, '0');

  insert into sales (
    business_id, branch_id, receipt_number, customer_id, status, payment_method,
    subtotal, tax_total, total, amount_tendered, change_given, cashier_id, created_by
  )
  values (
    v_business_id, p_branch_id, v_reference, p_customer_id,
    -- Inserted as awaiting_payment and moved to completed below by
    -- finalize_sale, so a cash sale and a momo sale reach 'completed'
    -- through exactly the same code.
    'awaiting_payment', v_summary,
    v_subtotal, v_tax_total, v_total, v_cash, v_change,
    p_cashier_id, auth.uid()
  )
  returning id into v_sale_id;

  -- SECOND PASS: the lines, and the stock they take out. The stock leaves
  -- now even if the money has not arrived — see the header.
  for v_item in select * from jsonb_array_elements(v_lines)
  loop
    insert into sale_items (
      sale_id, business_id, variant_id, description, sku, quantity,
      unit_price, tax_category, line_subtotal, line_tax, line_total
    )
    values (
      v_sale_id, v_business_id, (v_item ->> 'variant_id')::uuid,
      v_item ->> 'description', v_item ->> 'sku', (v_item ->> 'quantity')::numeric,
      (v_item ->> 'unit_price')::numeric, v_item ->> 'tax_category',
      (v_item ->> 'line_subtotal')::numeric, (v_item ->> 'line_tax')::numeric,
      (v_item ->> 'line_total')::numeric
    );

    insert into inventory_movements (
      business_id, branch_id, variant_id, quantity_delta, reason,
      reference_type, reference_id, note
    )
    values (
      '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
      p_branch_id, (v_item ->> 'variant_id')::uuid, -(v_item ->> 'quantity')::numeric, 'sale',
      'sale', v_sale_id, 'Sold on ' || v_reference
    );
  end loop;

  -- THIRD PASS: the tenders themselves.
  for v_pay in select * from jsonb_array_elements(v_tenders)
  loop
    v_method := v_pay ->> 'method';
    v_amount := case
      when v_method = 'cash' then v_cash
      when v_method = 'credit' then v_credit
      else (v_pay ->> 'amount')::numeric
    end;

    -- The old two-argument form passes amount_tendered = 0 for a credit
    -- sale, and a cash sale of a zero-priced item tenders nothing. There
    -- is no tender row to write in either case.
    continue when v_amount is null or v_amount <= 0;

    -- The id is generated here rather than defaulted, so that the
    -- reference Paystack will quote back to us can be the row's own id
    -- and still be written by the INSERT. It cannot be an UPDATE
    -- afterwards: `sale_payments` grants UPDATE to nobody, which is what
    -- stops a cashier marking their own momo prompt as received.
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
  'Rings up a sale in one transaction: the sale and its lines, the stock movements that take the goods out, and one row per tender. Prices and tax rates are read from the database, never accepted from the caller. A sale with a mobile money tender is left awaiting_payment until settle_sale_payment() reports the charge succeeded.';

-- ── settling a mobile money payment ─────────────────────────────────────
--
-- Reached only from our own server: from the verified Paystack webhook,
-- or from a verify call the till makes when the webhook is slow. There is
-- no user at either end of that, which is exactly why this is the one
-- function granted to service_role alone.

create or replace function settle_sale_payment(
  p_payment_id uuid,
  p_status text,               -- 'success' | 'failed'
  p_provider_charge_id text,
  p_failure_reason text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment sale_payments%rowtype;
  v_sale    sales%rowtype;
  v_paid    numeric(14, 2);
begin
  if p_status not in ('success', 'failed') then
    raise exception 'A payment settles as success or failed' using errcode = '22023';
  end if;

  select * into v_payment from sale_payments where id = p_payment_id for update;
  if v_payment.id is null then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;

  -- A webhook retry, or the till's verify call racing the webhook. Both
  -- are routine, and neither is an error — report what already happened.
  if v_payment.status <> 'pending' then
    return v_payment.status;
  end if;

  update sale_payments
  set status = p_status,
      provider_charge_id = coalesce(p_provider_charge_id, provider_charge_id),
      failure_reason = case when p_status = 'failed' then p_failure_reason else null end,
      settled_at = now()
  where id = p_payment_id;

  if p_status = 'failed' then
    return 'failed';
  end if;

  select * into v_sale from sales where id = v_payment.sale_id;

  -- finalize_sale recomputes this itself and refuses a sale that is
  -- short, so this is only deciding whether it is worth asking. Cash is
  -- counted at what was handed over less the change that went back, which
  -- is why change_given is subtracted rather than each cash row capped.
  select coalesce(sum(amount), 0) - v_sale.change_given into v_paid
  from sale_payments
  where sale_id = v_payment.sale_id and status = 'success';

  if v_paid >= v_sale.total and v_sale.status = 'awaiting_payment' then
    perform finalize_sale(v_sale.id);
    return 'completed';
  end if;

  return 'success';
end;
$$;

revoke all on function settle_sale_payment(uuid, text, text, text) from public, authenticated, anon;
grant execute on function settle_sale_payment(uuid, text, text, text) to service_role;

comment on function settle_sale_payment(uuid, text, text, text) is
  'Records the outcome of a mobile money charge and completes the sale once its payments cover the total. Idempotent: a repeated webhook for a payment that is already settled returns the settled status and changes nothing. service_role only — a browser never settles a payment.';

-- ── giving up on a sale the money never came for ────────────────────────

-- SECURITY DEFINER, unlike void_sale next door, for one reason: it has to
-- mark the pending tender cancelled, and `sale_payments` grants UPDATE to
-- nobody at all — that revoke is what stops a cashier marking their own
-- momo prompt as received, and it is worth more than invoker semantics
-- here. The permission and status checks below are therefore doing the
-- work RLS would otherwise do, and are not optional.
create or replace function cancel_unpaid_sale(p_sale_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale  sales%rowtype;
  v_item  record;
  v_rows  int;
begin
  perform pg_advisory_xact_lock(hashtextextended('sale_correction:' || p_sale_id::text, 0));

  select * into v_sale from sales where id = p_sale_id;
  if v_sale.id is null then
    raise exception 'Sale not found' using errcode = 'P0002';
  end if;
  if v_sale.status <> 'awaiting_payment' then
    raise exception 'Only a sale still waiting for payment can be cancelled' using errcode = 'P0001';
  end if;

  -- Checked here as well as in the trigger so that a caller without the
  -- permission is told so, instead of writing every stock reversal below
  -- and then finding the status update silently matched no rows. (That
  -- exact shape was a real bug in 0021's void_sale.)
  if not (app_has_permission(v_sale.business_id, 'sales.process') or app_is_super_admin()) then
    raise exception 'Missing permission: sales.process' using errcode = '42501';
  end if;

  -- Any tender that had already landed is now moot; a pending momo prompt
  -- the customer approves after this is refused by settle_sale_payment,
  -- because the row is no longer pending.
  update sale_payments
  set status = 'cancelled', settled_at = now()
  where sale_id = p_sale_id and status = 'pending';

  -- The goods go back. They left the shelf when the cart was rung up.
  for v_item in select variant_id, quantity from sale_items where sale_id = p_sale_id
  loop
    insert into inventory_movements (
      business_id, branch_id, variant_id, quantity_delta, reason,
      reference_type, reference_id, note
    )
    values (
      '00000000-0000-0000-0000-000000000000', -- replaced by the BEFORE trigger
      v_sale.branch_id, v_item.variant_id, v_item.quantity, 'sale_cancelled',
      'sale', p_sale_id, coalesce(nullif(p_reason, ''), 'Payment not completed')
    );
  end loop;

  update sales set status = 'cancelled' where id = p_sale_id;

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'Could not cancel that sale' using errcode = 'P0001';
  end if;
end;
$$;

grant execute on function cancel_unpaid_sale(uuid, text) to authenticated;

comment on function cancel_unpaid_sale(uuid, text) is
  'Abandons a sale whose payment never completed: puts the goods back on the shelf, marks any pending tender cancelled, and marks the sale cancelled. Not a void — nothing was ever paid, so there is nothing to give back.';

-- ── voiding and refunding only apply to a sale that completed ───────────
--
-- 0021 wrote both against a world with two statuses. A sale sitting at
-- awaiting_payment is not a sale anyone can void or refund — it is one
-- to cancel — and both functions already require status = 'completed',
-- so they need no change. This comment is here so the next person does
-- not go looking for one.

-- ── settlement can also be reported by the till ─────────────────────────
--
-- Paystack gives the customer 180 seconds and sends charge.success when
-- they approve. If that webhook is slow or lost, the till asks Paystack
-- directly (Verify Transaction) and reports the answer through the same
-- settle_sale_payment above, using the server's service-role client. So
-- there is one settlement path, not two.

create or replace function sale_payment_summary(p_sale_id uuid)
returns table (
  method text,
  amount numeric,
  status text
)
language sql
stable
as $$
  select method, amount, status
  from sale_payments
  where sale_id = p_sale_id
  order by created_at;
$$;

grant execute on function sale_payment_summary(uuid) to authenticated;
