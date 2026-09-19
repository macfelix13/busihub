"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function signOut() {
  const supabase = await createServerSupabaseClient();
  // { scope: 'local' } — without it, supabase-js defaults to 'global',
  // which revokes the refresh token for every session of this user on
  // every device, not just the one that clicked "Log out" here. A cashier
  // or owner ending their shift on one till should never sign anyone else
  // (or their own other tabs/devices) out.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}