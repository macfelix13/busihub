-- Busihub — 0047: a webhook identifier separate from business_id, and
-- audit logging reaches the Paystack webhook route
--
-- Two small, additive changes, both requested directly after a "Test
-- connection" pass over Settings -> Payments (see docs/ARCHITECTURE.md's
-- changelog for the inspection that preceded all of this).
--
-- ONE: business_payment_settings gains webhook_identifier — a value with
-- nothing in common with business_id, generated the same way every other
-- opaque id in this schema already is (gen_random_uuid()). Nothing before
-- this migration was actually broken: the HMAC signature, not the URL, is
-- what stands between a stranger and a fake webhook (see webhook.ts). But
-- business_id turns up in plenty of ordinary application URLs and API
-- responses, while this value is meant to appear nowhere else at all —
-- and unlike a business_id, it can be thrown away and replaced. There is
-- deliberately no UPDATE grant on the column; regenerate_paystack_webhook_
-- identifier() below is the only sanctioned way to change it, the same
-- shape as every other sensitive write path in this schema
-- (cancel_unpaid_sale, settle_sale_payment, and so on).
--
-- Existing connected shops are not broken by this. The webhook route
-- (application code, not this migration) keeps recognising the OLD
-- business_id-shaped URL as a fallback, so a shop that already pasted
-- that URL into Paystack does not have to notice anything changed. New
-- shops, and anyone who clicks "Regenerate", get the new kind of URL.
--
-- TWO: log_audit_event() (0008) is granted to service_role. The Paystack
-- webhook route runs with no authenticated user at all — an incoming
-- webhook has no person behind it, same as settle_sale_payment already
-- reasons about — so it is the one caller in this app that needs to write
-- an audit row as service_role rather than as itself. actor_user_id on
-- these rows is null, the same shape as the platform.super_admin_granted
-- precedent (0035) for an action with nobody on the other end of it.

alter table business_payment_settings
  add column webhook_identifier uuid not null default gen_random_uuid();

alter table business_payment_settings
  add constraint business_payment_settings_webhook_identifier_key unique (webhook_identifier);

comment on column business_payment_settings.webhook_identifier is
  'The path segment in this shop''s Paystack webhook URL. Unrelated to business_id on purpose — see this migration''s header — and safe to hand out freely: it identifies which shop an event is FOR, it does not authenticate the event (the HMAC signature check does that). The only way to change it is regenerate_paystack_webhook_identifier() — there is no UPDATE grant on the column itself.';

-- MAINTENANCE NOTE, same as 0022's for this table: a future column needs
-- its own grant below or it will be invisible/unwritable. webhook_identifier
-- deliberately gets a SELECT grant and NO update grant.
grant select (webhook_identifier) on business_payment_settings to authenticated;

-- ── regenerating a webhook identifier ────────────────────────────────────

create or replace function regenerate_paystack_webhook_identifier(p_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new uuid;
  v_rows int;
begin
  if not (app_has_permission(p_business_id, 'business.manage') or app_is_super_admin()) then
    raise exception 'Missing permission: business.manage' using errcode = '42501';
  end if;

  v_new := gen_random_uuid();

  update business_payment_settings
  set webhook_identifier = v_new
  where business_id = p_business_id;

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'Connect a Paystack account before regenerating its webhook URL' using errcode = 'P0001';
  end if;

  return v_new;
end;
$$;

revoke all on function regenerate_paystack_webhook_identifier(uuid) from public, anon;
grant execute on function regenerate_paystack_webhook_identifier(uuid) to authenticated;

comment on function regenerate_paystack_webhook_identifier(uuid) is
  'Issues a new webhook_identifier for a business, replacing the old one immediately — the old URL stops meaning anything from this moment on, whether or not Paystack has been told about the new one yet. SECURITY DEFINER so it can write a column with no UPDATE grant; the permission check inside does the work RLS would otherwise do.';

-- ── letting the webhook route write an audit trail ───────────────────────

grant execute on function log_audit_event(uuid, uuid, text, text, uuid, jsonb, inet, text) to service_role;