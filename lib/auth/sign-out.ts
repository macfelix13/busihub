"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function signOut() {
  const supabase = await createServerSupabaseClient();
  // { scope: 'local' } — without it, supabase-js defaults to 'global',
  // which revokes the refresh token for every session of this user on
  // every device, not just the one that clicked "Log out" here. A cashier
  // or owner ending their shift on one till should never sign anyone else
  // (or their own other tabs/devices) out.
  await supabase.auth.signOut({ scope: "local" });

  // Throws away this browser tab's client-side Router Cache for every
  // route, not just the one being redirected to. Without this, a page
  // this account visited earlier in the tab's life (Products, Till, ...)
  // can still be sitting in that cache when the NEXT account signs in on
  // the same device, and clicking back to it (a nav link, not a fresh
  // URL/hard refresh) can briefly reuse the stale render instead of
  // asking the server again — no data actually crosses between
  // businesses server-side, but on screen it can look exactly like it
  // did. See this fix's docs/ARCHITECTURE.md changelog entry for the
  // fuller writeup of how this was diagnosed.
  revalidatePath("/", "layout");
  redirect("/login");
}