import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * True only for platform staff — profiles.is_super_admin, set exclusively
 * by the bootstrap_super_admin() SQL function (0035) run by hand in the
 * Supabase SQL editor. Never inferred from a client-supplied value, a URL,
 * or a prop threaded down from somewhere else that already checked it for
 * a different request — every /admin page and Server Action calls this
 * itself (Section 49), the same way every (app) page calls hasPermission
 * itself rather than trusting its layout's check.
 *
 * Reads the flag directly rather than going through app_is_super_admin()
 * (0008): that RPC is for RLS policies to call on the database side, and
 * routing an application check through it would need a policy that lets
 * `authenticated` select is_super_admin off an arbitrary profiles row,
 * which profiles_select (0009) already grants for the *caller's own* row
 * (id = auth.uid()) — this just reads that one column off it.
 */
export async function isSuperAdmin(supabase: SupabaseClient): Promise<boolean> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return false;

  const { data, error } = await supabase
    .from("profiles")
    .select("is_super_admin")
    .eq("id", user.id)
    .maybeSingle();

  // Fail closed: a broken check reads as "not a super admin", never as
  // "super admin by default".
  if (error) return false;

  return data?.is_super_admin === true;
}