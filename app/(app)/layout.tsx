import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { LogoutButton } from "@/components/logout-button";

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
    .select("id, first_name, last_name, business_id, businesses!profiles_business_id_fkey (name)")
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

  const businessName = (profile as unknown as { businesses: { name: string } | null }).businesses?.name;

  // Cosmetic nav visibility only — every page/action behind these links
  // re-checks the same permission server-side (Section 49).
  const [canManageBranches, canManageBusiness, canViewProducts, canViewInventory, canViewSuppliers, canViewCustomers] =
    await Promise.all([
      hasPermission(supabase, profile.business_id!, PERMISSIONS.BRANCHES_MANAGE),
      hasPermission(supabase, profile.business_id!, PERMISSIONS.BUSINESS_MANAGE),
      hasPermission(supabase, profile.business_id!, PERMISSIONS.PRODUCTS_VIEW),
      hasPermission(supabase, profile.business_id!, PERMISSIONS.INVENTORY_VIEW),
      hasPermission(supabase, profile.business_id!, PERMISSIONS.SUPPLIERS_VIEW),
      hasPermission(supabase, profile.business_id!, PERMISSIONS.CUSTOMERS_VIEW),
    ]);

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="flex flex-col gap-3 border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-brand-600 px-2 py-1 text-sm font-bold text-white">B</span>
          <span className="font-semibold">{businessName ?? "Busihub"}</span>
        </div>
        <nav className="flex items-center gap-4 text-sm font-medium text-neutral-600 dark:text-neutral-300">
          <Link href="/dashboard" className="hover:text-neutral-900 dark:hover:text-white">
            Dashboard
          </Link>
          {canViewProducts ? (
            <Link href="/products" className="hover:text-neutral-900 dark:hover:text-white">
              Products
            </Link>
          ) : null}
          {canViewInventory ? (
            <Link href="/inventory" className="hover:text-neutral-900 dark:hover:text-white">
              Inventory
            </Link>
          ) : null}
          {canViewSuppliers ? (
            <>
              <Link href="/purchase-orders" className="hover:text-neutral-900 dark:hover:text-white">
                Orders
              </Link>
              <Link href="/suppliers" className="hover:text-neutral-900 dark:hover:text-white">
                Suppliers
              </Link>
            </>
          ) : null}
          {canViewCustomers ? (
            <Link href="/customers" className="hover:text-neutral-900 dark:hover:text-white">
              Customers
            </Link>
          ) : null}
          {canManageBranches ? (
            <Link href="/branches" className="hover:text-neutral-900 dark:hover:text-white">
              Branches
            </Link>
          ) : null}
          {canManageBusiness ? (
            <Link href="/settings/business" className="hover:text-neutral-900 dark:hover:text-white">
              Settings
            </Link>
          ) : null}
        </nav>
        <div className="flex items-center gap-4">
          <span className="hidden text-sm text-neutral-500 sm:inline">
            {profile.first_name} {profile.last_name}
          </span>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
