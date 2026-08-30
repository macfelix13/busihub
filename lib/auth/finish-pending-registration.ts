import "server-only";
import type { createServerSupabaseClient } from "@/lib/supabase/server";

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

/**
 * Finishes business registration for a user who signed up while email
 * confirmation was required — register_business() (Section 5) couldn't
 * run at signUp() time because there was no session yet for it to read
 * auth.uid() from, so the pending business details were carried on
 * user_metadata instead (see app/(auth)/register/actions.ts).
 *
 * Called from both places a session can first come into existence after
 * that kind of signUp: a normal password login (app/(auth)/login/actions.ts)
 * and the PKCE code-exchange callback for the confirmation email link
 * (app/auth/confirm/route.ts). Safe to call unconditionally — it's a
 * no-op for a user who already has a profile, or who never had pending
 * business metadata (e.g. a Super Admin, or a future staff-invite flow).
 *
 * Requires `supabase` to already be authenticated as the target user
 * (i.e. called after signInWithPassword() or exchangeCodeForSession()
 * resolved), since register_business() is SECURITY DEFINER and reads
 * auth.uid() from the session, not from an argument.
 *
 * Throws on a genuine failure (register_business() RPC error) so callers
 * can decide how to surface that — the two current callers show slightly
 * different messages depending on context.
 */
export async function finishPendingRegistrationIfNeeded(
  supabase: ServerSupabaseClient
): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (profile) return;

  const meta = user.user_metadata as Record<string, unknown>;
  const pendingBusinessName =
    typeof meta.pending_business_name === "string" ? meta.pending_business_name : null;

  // No pending business metadata — nothing to finish (e.g. a Super Admin
  // account, or a future staff-invite flow with no business of its own).
  if (!pendingBusinessName) return;

  const { error } = await supabase.rpc("register_business", {
    p_business_name: pendingBusinessName,
    p_owner_first_name: typeof meta.first_name === "string" ? meta.first_name : "",
    p_owner_last_name: typeof meta.last_name === "string" ? meta.last_name : "",
    p_phone: typeof meta.pending_business_phone === "string" ? meta.pending_business_phone : null,
  });

  if (error) {
    throw new Error(`register_business failed: ${error.message}`);
  }
}
