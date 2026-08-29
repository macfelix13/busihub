-- Busihub — development/test seed data
--
-- ⚠ DEVELOPMENT AND TEST ONLY. Never run this against a production
-- project — it creates a real (if clearly fake) auth user with a known
-- password. `npm run db:seed` refuses to run unless SUPABASE_DB_URL does
-- not look like a production connection string is asserted by the
-- operator; see scripts/db-seed.mjs for the confirmation prompt.
--
-- Everything below is run as the Postgres superuser (via the direct DB
-- connection), which bypasses RLS — that's expected and fine for seeding.
-- It does NOT go through register_business()/Supabase Auth's normal
-- signup flow because there is no HTTP session/JWT in a psql script;
-- instead it inserts directly into auth.users the way Supabase's own
-- local dev tooling does, then performs the same steps register_business
-- would have performed.

do $$
declare
  v_user_id uuid := '00000000-0000-0000-0000-000000000001';
  v_business_id uuid;
  v_branch_id uuid;
  v_owner_role_id uuid;
  v_cashier_role_id uuid;
  v_trial_plan_id uuid;
begin
  if exists (select 1 from auth.users where id = v_user_id) then
    raise notice 'Seed data already present, skipping.';
    return;
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
  ) values (
    '00000000-0000-0000-0000-000000000000', v_user_id, 'authenticated', 'authenticated',
    'owner@busihub.dev.example',
    crypt('DevPassword123!', gen_salt('bf')),
    now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'
  );

  insert into businesses (name, slug, currency_code, country_code, phone)
    values ('Busihub Demo Store', 'busihub-demo-store', 'GHS', 'GH', '+233200000000')
    returning id into v_business_id;

  insert into business_settings (business_id) values (v_business_id);

  insert into branches (business_id, name, is_main, city, region)
    values (v_business_id, 'Main Branch', true, 'Accra', 'Greater Accra')
    returning id into v_branch_id;

  insert into profiles (id, business_id, first_name, last_name, email)
    values (v_user_id, v_business_id, 'Demo', 'Owner', 'owner@busihub.dev.example');

  update businesses set created_by = v_user_id where id = v_business_id;

  perform seed_default_roles_for_business(v_business_id);

  select id into v_owner_role_id from roles where business_id = v_business_id and name = 'Owner';
  select id into v_cashier_role_id from roles where business_id = v_business_id and name = 'Cashier';

  insert into user_branch_roles (business_id, branch_id, user_id, role_id, granted_by)
    values (v_business_id, v_branch_id, v_user_id, v_owner_role_id, v_user_id);

  select id into v_trial_plan_id from subscription_plans where slug = 'trial';
  insert into business_subscriptions (business_id, plan_id, status, trial_ends_at, current_period_end)
    values (v_business_id, v_trial_plan_id, 'trialing', now() + interval '14 days', now() + interval '14 days');

  raise notice 'Seed complete. Sign in with owner@busihub.dev.example / DevPassword123! (dev only).';
end $$;
