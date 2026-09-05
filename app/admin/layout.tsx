import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSuperAdmin } from "@/lib/auth/is-super-admin";
import { LogoutButton } from "@/components/logout-button";

/**
 * Deliberately separate from app/(app)/layout.tsx — not a variant of it,
 * not sharing AppShell/Sidebar. Everything under (app) assumes a
 * business_id and renders tenant nav (Till, Products, Reports…) scoped to
 * one business; a Super Admin profile has business_id = null (0004) and
 * has no business to be scoped to here at all. Keeping this shell
 * completely separate means there is no shared component that could ever
 * accidentally leak a "which business" assumption between the two.
 *
 * The redirect below is UX, not the security boundary — same as every
 * other layout guard in this app. The real boundary is that every /admin
 * page and Server Action calls isSuperAdmin()/requires it again itself,
 * and RLS (app_is_super_admin(), 0008) is the backstop under that.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Sent to the ordinary tenant dashboard, not an error page — a business
  // user hitting /admin by guessing the URL should see nothing suggesting
  // this area exists, just land somewhere normal.
  if (!(await isSuperAdmin(supabase))) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900 sm:px-6">
        <Link href="/admin/businesses" className="font-semibold">
          Busihub Admin
        </Link>
        <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-xs font-medium text-white dark:bg-white dark:text-neutral-900">
          Platform
        </span>
        <div className="ml-auto flex flex-shrink-0 items-center">
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}