-- Busihub — 0037: a Cashier sees their own sales, not the whole shop's.
--
-- 0020/0021/0022 gave read access to sales, sale_items, refunds,
-- refund_items and sale_payments to anyone holding EITHER sales.process
-- (that's the Cashier role) OR reports.view (Manager, Owner, Accountant,
-- Auditor) — an unconditional "or", with no restriction on WHICH rows a
-- sales.process holder could see. In practice that meant any Cashier could
-- read every sale ever rung up by every colleague, in every branch, for
-- the whole life of the business — not just their own till. reports.view
-- holders were always correctly unrestricted; it is the Cashier side that
-- was too open.
--
-- The fix narrows the sales.process branch of each policy to the caller's
-- OWN sales — cashier_id = auth.uid() — while leaving the reports.view
-- branch exactly as open as before. This has to happen in the RLS policy
-- itself, not by filtering a query on some page: RLS is what actually
-- stops a Cashier reading someone else's sale directly (through the
-- browser client, or any future screen), no matter what any particular
-- page's query does or does not filter for.
--
-- cashier_id is who was PIN-verified at the till for that specific sale
-- (lib/auth/till-session.ts, migrations 0018-0020) — usually, but not
-- always, the same person as the account logged into the browser
-- (created_by/auth.uid()). The till (app/(app)/till/page.tsx) requires a
-- successful PIN sign-in before it will even render the selling screen,
-- so every sale created through the normal till flow has a cashier_id;
-- this is not "restrict to a column that is sometimes null".
--
-- KNOWN, DELIBERATE LIMITATION: if the browser is logged in as one person
-- (auth.uid()) while a DIFFERENT person PIN-verifies for a given sale
-- (cashier_id), only the PIN-verified person — not the logged-in one —
-- can read that sale back afterward unless the logged-in one also holds
-- reports.view. On a shared till this is normally fine, because the
-- account left logged into a shared device is typically a Manager or
-- Owner (who has reports.view and is unrestricted either way). It only
-- bites if a plain Cashier-role account is both the browser's login AND
-- is letting a *different* colleague PIN in on their session — an unusual
-- arrangement, not the intended one. If that turns out to matter in
-- practice, the fix is to add "or created_by = auth.uid()" to each of the
-- policies below.
--
-- sale_items, refund_items and sale_payments have no cashier_id of their
-- own — each is scoped by joining back to the sale (or refund) that owns
-- it, since that is what "belongs to this cashier" actually means for a
-- line or a tender.

-- ── sales ────────────────────────────────────────────────────────────────

drop policy sales_select on sales;

create policy sales_select on sales
  for select
  using (
    app_has_permission(business_id, 'reports.view')
    or app_is_super_admin()
    or (
      app_has_permission(business_id, 'sales.process')
      and cashier_id = auth.uid()
    )
  );

drop policy sale_items_select on sale_items;

create policy sale_items_select on sale_items
  for select
  using (
    app_has_permission(business_id, 'reports.view')
    or app_is_super_admin()
    or (
      app_has_permission(business_id, 'sales.process')
      and exists (
        select 1 from sales s
        where s.id = sale_items.sale_id and s.cashier_id = auth.uid()
      )
    )
  );

-- ── refunds ──────────────────────────────────────────────────────────────
-- Scoped by the REFUND's own cashier_id (who processed the return), not
-- the original sale's — symmetrical with sales above. In the default role
-- seed this branch never actually fires for a Cashier: sales.refund is a
-- Manager/Owner-only permission, and both of those already hold
-- reports.view. It matters only for a custom role that combines
-- sales.process + sales.refund without reports.view.
--
-- One consequence of that custom-role case, worth knowing about: such a
-- role could no longer refund a colleague's sale, because create_refund()
-- has to read that sale's sale_items to snapshot the price/cost being
-- returned, and sale_items_select applies the exact same "your own
-- cashier_id, unless reports.view" restriction. Before this migration
-- sale_items were unconditionally visible to any sales.process holder, so
-- that combination worked; now it only works for their own sales, or with
-- reports.view added. Neither built-in role is affected — Manager already
-- holds both sales.refund and reports.view — this only matters if a
-- custom role is ever built with sales.refund alone.

drop policy refunds_select on refunds;

create policy refunds_select on refunds
  for select
  using (
    app_has_permission(business_id, 'reports.view')
    or app_is_super_admin()
    or (
      app_has_permission(business_id, 'sales.process')
      and cashier_id = auth.uid()
    )
  );

drop policy refund_items_select on refund_items;

create policy refund_items_select on refund_items
  for select
  using (
    app_has_permission(business_id, 'reports.view')
    or app_is_super_admin()
    or (
      app_has_permission(business_id, 'sales.process')
      and exists (
        select 1 from refunds r
        where r.id = refund_items.refund_id and r.cashier_id = auth.uid()
      )
    )
  );

-- ── sale_payments ────────────────────────────────────────────────────────
-- No cashier_id of its own (only created_by, which this migration
-- deliberately does not use — see the note above) — a tender belongs to
-- whichever cashier the sale itself belongs to.

drop policy sale_payments_select on sale_payments;

create policy sale_payments_select on sale_payments
  for select
  using (
    app_has_permission(business_id, 'reports.view')
    or app_is_super_admin()
    or (
      app_has_permission(business_id, 'sales.process')
      and exists (
        select 1 from sales s
        where s.id = sale_payments.sale_id and s.cashier_id = auth.uid()
      )
    )
  );