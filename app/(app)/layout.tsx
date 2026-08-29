import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
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

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, business_id, businesses (name)")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) {
    // Authenticated but no business/profile link yet (e.g. email
    // confirmation pending, or the register_business() RPC failed after
    // signUp — see app/(auth)/login/actions.ts). Nothing under (app) can
    // render sensibly without a business_id.
    redirect("/login");
  }

  const businessName = (profile as unknown as { businesses: { name: string } | null }).businesses?.name;

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-brand-600 px-2 py-1 text-sm font-bold text-white">B</span>
          <span className="font-semibold">{businessName ?? "Busihub"}</span>
        </div>
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
