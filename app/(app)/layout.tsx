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
import { resolveBusinessThemeOverride, businessThemeOverrideScript, resolvePrimaryColorOverride, accentOverrideStyle } from "@/lib/theme";
import { getSubscriptionSummary } from "@/lib/entitlements/queries";
import { isLockedOutStatus, isGracePeriodStatus, graceDaysRemaining } from "@/lib/entitlements/limits";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { SubscribeButton } from "@/app/(app)/settings/billing/subscribe-button";

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

  if (!profile.business_id) {
    // profiles_business_required_unless_super_admin (0004) guarantees a
    // null business_id only ever belongs to a genuine Super Admin — an
    // ordinary user always has one. Without this check that combination
    // still couldn't see anything today: getCurrentBusinessId() below
    // throws NoBusinessError for a null app_current_business_id(), and
    // this layout's own catch sends it to /login. But that's an
    // incidental side effect of an RPC throwing, not a deliberate rule —
    // and it bounces a legitimate Super Admin back to the login screen
    // instead of where they actually work. This makes the intent
    // explicit and sends them somewhere useful.
    //
    // This also closes a real incident, not just a hypothetical: a
    // profile that was both a business owner (business_id set) AND
    // is_super_admin = true bypassed tenant isolation on every ordinary
    // (app) page, because every RLS policy's "or app_is_super_admin()"
    // escape hatch doesn't know or care which route issued the query
    // (see docs/ARCHITECTURE.md's changelog for the full writeup). The
    // fix for that specific account was clearing its business_id in the
    // database; this is the code-side guard so the same misconfiguration
    // can't quietly leak tenant data again through this layout even if
    // it recurs.
    redirect("/admin");
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
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 dark:bg-canvas-dark">
        <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 text-center dark:border-surface-line dark:bg-surface-card">
          <h1 className="text-lg font-semibold">
            {business.status === "suspended" ? "Account suspended" : "Account closed"}
          </h1>
          <p className="mt-2 text-sm text-neutral-500 dark:text-ink-muted">
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
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 dark:bg-canvas-dark">
        <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 text-center dark:border-surface-line dark:bg-surface-card">
          <h1 className="text-lg font-semibold">Account deactivated</h1>
          <p className="mt-2 text-sm text-neutral-500 dark:text-ink-muted">
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

  // Phase 18 (Subscriptions & entitlements enforcement, 0058): a lapsed
  // subscription locks a business out of the app entirely — exactly the
  // same "declared but never enforced until now" story the business/
  // profile status checks above already tell. business_subscriptions.
  // status has existed since 0006, and this is the first thing that ever
  // reads it here. suspended/cancelled/expired lock out fully (same UI
  // shape as the business-status block above); past_due is the grace
  // window after a trial runs out (process_subscription_lifecycle(),
  // 0058) and gets a banner, not a wall — see lib/entitlements/limits.ts's
  // isLockedOutStatus()/isGracePeriodStatus() for the exact rule, and
  // that same migration's file header for why real billing isn't part
  // of this phase (a subscription's plan/status is set by a Super Admin
  // by hand, via admin_set_business_subscription(), until it is).
  const subscription = await getSubscriptionSummary(supabase, businessId);
  let subscriptionGraceBanner: React.ReactNode = null;

  if (subscription && isLockedOutStatus(subscription.status)) {
    const email = supportEmail();
    const phone = supportPhone();
    const whatsappDigits = phone.replace(/[^0-9]/g, "");
    const reason =
      subscription.status === "suspended"
        ? "This business's Busihub subscription has been suspended."
        : subscription.status === "cancelled"
          ? "This business's Busihub subscription has been cancelled."
          : "This business's free trial ended and no plan was chosen in time.";

    // Self-serve billing (0061) gave a business a way to pay its own way
    // back in without waiting on a Super Admin — but only offered here for
    // `expired` (a trial that simply ran out with no plan chosen), and only
    // to whoever could actually act on it (business.manage — the same gate
    // settings/billing/page.tsx itself uses, since that page is otherwise
    // unreachable from behind this same wall). suspended/cancelled stay
    // contact-only on purpose: those are Busihub's own decisions, not
    // something a business should be able to pay its way around before
    // support has looked at it.
    let expiredPlans: { id: string; name: string; price_amount: string; currency_code: string; billing_interval: string }[] = [];
    if (subscription.status === "expired") {
      const canSelfServe = await hasPermission(supabase, businessId, PERMISSIONS.BUSINESS_MANAGE);
      if (canSelfServe) {
        const { data: planRows, error: plansError } = await supabase
          .from("subscription_plans")
          .select("id, name, price_amount, currency_code, billing_interval")
          .eq("is_active", true)
          .not("paystack_plan_code", "is", null)
          .order("sort_order", { ascending: true });
        if (plansError) {
          console.error("(app) layout: expired-lockout plans query failed", plansError);
        }
        expiredPlans = planRows ?? [];
      }
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 dark:bg-canvas-dark">
        <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 text-center dark:border-surface-line dark:bg-surface-card">
          <h1 className="text-lg font-semibold">Subscription required</h1>
          <p className="mt-2 text-sm text-neutral-500 dark:text-ink-muted">
            {reason} Contact Busihub support to choose a plan and get back in.
          </p>

          {expiredPlans.length > 0 ? (
            <div className="mt-4 border-t border-neutral-100 pt-4 text-left dark:border-surface-line">
              <p className="text-sm font-medium">Or subscribe yourself right now:</p>
              <div className="mt-2 flex flex-col gap-2">
                {expiredPlans.map((plan) => (
                  <div
                    key={plan.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-neutral-200 px-3 py-2.5 dark:border-surface-line"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{plan.name}</p>
                      <p className="text-xs text-neutral-500 dark:text-ink-muted">
                        {formatMoney(toMinorUnits(plan.price_amount), plan.currency_code)} / {plan.billing_interval}
                      </p>
                    </div>
                    <SubscribeButton planId={plan.id} planName={plan.name} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}

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

  if (subscription && isGracePeriodStatus(subscription.status)) {
    const daysLeft = graceDaysRemaining(subscription.pastDueSince);
    subscriptionGraceBanner = (
      <div className="bg-amber-50 px-4 py-2.5 text-center text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        Your free trial has ended.{" "}
        {daysLeft !== null && daysLeft > 0
          ? `You have ${daysLeft} day${daysLeft === 1 ? "" : "s"} left before this account is locked.`
          : "This account will be locked very soon."}{" "}
        <a href="/settings/billing" className="font-medium underline">
          Choose a plan
        </a>
        .
      </div>
    );
  }

  // Settings → Business → Appearance's "Theme" and "Primary color"
  // fields — see lib/theme.ts for why only an explicit "light"/"dark"
  // theme choice does anything (not "system", every business's untouched
  // default), and why only a color that isn't the untouched factory
  // default does anything either.
  const { data: settingsRow } = await supabase
    .from("business_settings")
    .select("appearance_settings")
    .eq("business_id", businessId)
    .maybeSingle();
  const appearance = settingsRow?.appearance_settings as { theme?: string; primary_color?: string } | null;
  const businessThemeOverride = resolveBusinessThemeOverride(appearance?.theme);
  const primaryColorOverride = resolvePrimaryColorOverride(appearance?.primary_color);

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
    canManageRoles,
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
      hasPermission(supabase, businessId, PERMISSIONS.ROLES_MANAGE),
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
    canManageRoles,
    canViewAudit,
  };

  return (
    <>
      {businessThemeOverride ? (
        // Placed before AppShell so it runs, and can flip the `dark`
        // class if needed, before any of AppShell's content paints —
        // see lib/theme.ts's businessThemeOverrideScript() doc comment.
        <script dangerouslySetInnerHTML={{ __html: businessThemeOverrideScript(businessThemeOverride) }} />
      ) : null}
      {primaryColorOverride ? (
        // A plain <style> rather than a script — unlike theme, a color
        // has no per-device "already chosen" localStorage state to check
        // first, so there's nothing to defer to the browser for. See
        // lib/theme.ts's accentOverrideStyle() for exactly which CSS
        // variables this sets and why.
        <style dangerouslySetInnerHTML={{ __html: accentOverrideStyle(primaryColorOverride) }} />
      ) : null}
      {subscriptionGraceBanner}
      <AppShell
        permissions={navPermissions}
        businessName={businessName ?? "Busihub"}
        userLabel={`${profile.first_name} ${profile.last_name}`}
        notificationSlot={<NotificationBell />}
        logoutSlot={<LogoutButton />}
      >
        {children}
      </AppShell>
    </>
  );
}