import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { LogoutButton } from "@/components/logout-button";
import { supportEmail, supportPhone } from "@/lib/env";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { AppShell } from "@/components/layout/app-shell";
import type { NavPermissions } from "@/components/layout/nav-items";

/**
 * Every route under (app) requires a signed-in user with a linked
 * business profile. This is a convenience redirect for UX — the real
 * security boundary is RLS (every query below this layout is still
 * scoped by Postgres, not by this check) — but without it a
 * signed-out visitor would just see empty states instead of being sent
 * to /login, which is confusing rather than insecure.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    // businesses has two FKs to/from profiles (profiles.business_id ->
    // businesses.id, and businesses.created_by -> profiles.id), so the
    // embed must be disambiguated with the FK constraint name — a bare
    // `businesses (name)` is rejected by PostgREST with PGRST201
    // ("more than one relationship was found"). Confirmed against the
    // real schema; profiles_business_id_fkey is the one we want here.
    .select("id, first_name, last_name, business_id, status, businesses!profiles_business_id_fkey (name, status)")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    // A genuine query failure (RLS denial, PostgREST embed error, etc.)
    // looks identical to "no profile yet" if we only check `!profile` —
    // that swallowed real errors during testing and made this
    // undiagnosable. Log it distinctly so the two cases don't get
    // confused again.
    console.error("(app) layout: profiles query failed", profileError);
    redirect("/login");
  }

  if (!profile) {
    // Authenticated but no business/profile link yet (e.g. email
    // confirmation pending, or the register_business() RPC failed after
    // signUp — see app/(auth)/login/actions.ts). Nothing under (app) can
    // render sensibly without a business_id.
    redirect("/login");
  }

  const business = (profile as unknown as { businesses: { name: string; status: string } | null }).businesses;
  const businessName = business?.name;

  // Suspend/close has existed as a businesses.status value since the
  // earliest phases (0002) but nothing anywhere ever actually enforced
  // it — a "suspended" business's staff could sign in and use Busihub
  // exactly as before. This is the one enforcement point: every route
  // under (app), including the till, renders through this layout, so
  // checking here covers all of them without touching each page.
  if (business && business.status !== "active") {
    // Real, configurable values (lib/env.ts) — not hardcoded strings here —
    // so support can update them later via a Vercel env var + redeploy.
    // Shown for both suspended and closed: either way the owner needs a
    // way to reach Busihub, not just staff who happen to see "suspended".
    const email = supportEmail();
    const phone = supportPhone();
    const whatsappDigits = phone.replace(/[^0-9]/g, "");

    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 dark:bg-neutral-950">
        <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 text-center dark:border-neutral-800 dark:bg-neutral-900">
          <h1 className="text-lg font-semibold">
            {business.status === "suspended" ? "Account suspended" : "Account closed"}
          </h1>
          <p className="mt-2 text-sm text-neutral-500">
            {business.status === "suspended"
              ? "This business's Busihub account has been suspended. Contact Busihub support for help."
              : "This business's Busihub account is no longer active. Contact Busihub support if you believe this is a mistake."}
          </p>
          <div className="mt-4 flex flex-col items-center gap-1 text-sm">
            <a href={`mailto:${email}`} className="min-w-0 break-words text-brand-700 hover:underline dark:text-brand-300">
              {email}
            </a>
            <a
              href={`https://wa.me/${whatsappDigits}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-700 hover:underline dark:text-brand-300"
            >
              {phone} (WhatsApp)
            </a>
          </div>
          <div className="mt-5 flex justify-center">
            <LogoutButton />
          </div>
        </div>
      </div>
    );
  }

  // Staff deactivation (0036) has the exact same "declared but never
  // enforced" history the business-status check above did before the
  // Super Admin phase: profiles.status has existed since 0004, and
  // set_staff_status() (0036) can now actually flip it, but nothing here
  // read it before this — a deactivated colleague could still sign in and
  // use Busihub exactly as before. Checked after the business-status
  // block above (a business-level suspension takes priority in what it
  // tells the person), before anything else in (app) renders.
  if (profile.status !== "active") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 dark:bg-neutral-950">
        <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 text-center dark:border-neutral-800 dark:bg-neutral-900">
          <h1 className="text-lg font-semibold">Account deactivated</h1>
          <p className="mt-2 text-sm text-neutral-500">
            Your access to {businessName ?? "this business"} has been deactivated. Contact your business owner or
            manager if you think this is a mistake — Busihub support can&apos;t reactivate a staff account on your
            behalf.
          </p>
          <div className="mt-5 flex justify-center">
            <LogoutButton />
          </div>
        </div>
      </div>
    );
  }

  // Goes through the same cached lookup every page below uses (rather
  // than trusting profile.business_id from the query above) so that the
  // app_current_business_id() RPC runs at most ONCE per request: this is
  // the first thing on the page to ask for it, so it does the real round
  // trip, and every page's own getCurrentBusinessId(supabase) call below
  // this layout gets a cache hit instead of repeating it (0033).
  let businessId: string;
  try {
    businessId = await getCurrentBusinessId(supabase);
  } catch {
    redirect("/login");
  }

  // Cosmetic nav visibility only — every page/action behind these links
  // re-checks the same permission server-side (Section 49). Three more
  // than the old flat nav needed (canCreateProducts, canReceiveInventory,
  // canAdjustInventory): Products/Inventory becoming dropdowns gave their
  // existing action pages somewhere to live in the nav for the first time,
  // and each mirrors the exact permission the target page itself already
  // enforces (confirmed against each page's own hasPermission/
  // requirePermission call), not a new rule invented for the sidebar.
  const [
    canManageBranches,
    canManageBusiness,
    canViewProducts,
    canCreateProducts,
    canViewInventory,
    canReceiveInventory,
    canAdjustInventory,
    canViewSuppliers,
    canViewCustomers,
    canSell,
    canViewReports,
    canViewExpenses,
    canManageUsers,
    canViewAudit,
  ] =
    await Promise.all([
      hasPermission(supabase, businessId, PERMISSIONS.BRANCHES_MANAGE),
      hasPermission(supabase, businessId, PERMISSIONS.BUSINESS_MANAGE),
      hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_VIEW),
      hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CREATE),
      hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_VIEW),
      hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_RECEIVE),
      hasPermission(supabase, businessId, PERMISSIONS.INVENTORY_ADJUST),
      hasPermission(supabase, businessId, PERMISSIONS.SUPPLIERS_VIEW),
      hasPermission(supabase, businessId, PERMISSIONS.CUSTOMERS_VIEW),
      hasPermission(supabase, businessId, PERMISSIONS.SALES_PROCESS),
      hasPermission(supabase, businessId, PERMISSIONS.REPORTS_VIEW),
      hasPermission(supabase, businessId, PERMISSIONS.EXPENSES_VIEW),
      hasPermission(supabase, businessId, PERMISSIONS.USERS_MANAGE),
      hasPermission(supabase, businessId, PERMISSIONS.AUDIT_VIEW),
    ]);

  // Mirrors app/(app)/sales/page.tsx's own access check exactly — a
  // reports-only role (an accountant) reaches the sale history list
  // without ever seeing the till, same as before this redesign.
  const canViewSalesHistory = canSell || canViewReports;

  const navPermissions: NavPermissions = {
    canSell,
    canViewSalesHistory,
    canViewProducts,
    canCreateProducts,
    canViewInventory,
    canReceiveInventory,
    canAdjustInventory,
    canViewSuppliers,
    canViewCustomers,
    canViewExpenses,
    canManageBranches,
    canViewReports,
    canManageBusiness,
    canManageUsers,
    canViewAudit,
  };

  return (
    <AppShell
      permissions={navPermissions}
      businessName={businessName ?? "Busihub"}
      userLabel={`${profile.first_name} ${profile.last_name}`}
      notificationSlot={<NotificationBell />}
      logoutSlot={<LogoutButton />}
    >
      {children}
    </AppShell>
  );
}