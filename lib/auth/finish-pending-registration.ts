import "server-only";
import type { createServerSupabaseClient } from "@/lib/supabase/server";

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

/**
 * Which of the three things happened, so a caller can decide where to
 * send someone next (added 2026-09 alongside Google sign-in — see
 * app/auth/confirm/route.ts, the only caller that now branches on this;
 * app/(auth)/login/actions.ts still just awaits it and ignores the
 * result, since a password-based login can never hit "needs_business_name"
 * — see that case's own comment below):
 *
 *   - "already_set_up": a profile already existed. Nothing to do.
 *   - "created_business": pending_business_name metadata was present
 *     (an email/password signUp() that had it queued — see
 *     app/(auth)/register/actions.ts) and register_business() just ran.
 *   - "needs_business_name": no profile AND no pending metadata. Until
 *     2026-09 this was always a no-op ("nothing to finish", e.g. a Super
 *     Admin). Google/Apple sign-in made it a real, common case too: a
 *     brand-new OAuth sign-in has no business name at all yet, because
 *     the provider never sends one the way the email/password form
 *     collects one upfront. The caller must send this case to
 *     app/(auth)/onboarding/business before anywhere else — an
 *     authenticated user with no profile and no business would otherwise
 *     bounce between /login and /dashboard forever (every (app) page
 *     requires a profile, and profile-less redirects there straight back
 *     to /login).
 */
export type FinishRegistrationResult = "already_set_up" | "created_business" | "needs_business_name";

/**
 * Finishes business registration for a user who didn't get one at
 * signUp() time — either an email/password signup where email
 * confirmation was required (register_business() couldn't run yet, no
 * session to read auth.uid() from — pending_business_name was carried on
 * user_metadata instead, see app/(auth)/register/actions.ts) or a
 * brand-new Google/Apple sign-in, which never has that metadata at all.
 *
 * Called from every place a session can first come into existence:
 * app/(auth)/login/actions.ts (password login, possibly finishing a
 * pending email/password signup) and app/auth/confirm/route.ts (the
 * PKCE code-exchange callback — both the confirmation-email link AND
 * every OAuth sign-in land here). Safe to call unconditionally.
 *
 * Requires `supabase` to already be authenticated as the target user
 * (i.e. called after signInWithPassword(), exchangeCodeForSession(), or
 * verifyOtp() resolved), since register_business() is SECURITY DEFINER
 * and reads auth.uid() from the session, not from an argument.
 *
 * Throws on a genuine failure (register_business() RPC error) so callers
 * can decide how to surface that.
 */
export async function finishPendingRegistrationIfNeeded(
  supabase: ServerSupabaseClient
): Promise<FinishRegistrationResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Shouldn't happen — this is only ever called right after a successful
  // signInWithPassword()/exchangeCodeForSession()/verifyOtp(). If it ever
  // does, "already_set_up" is the safe choice: it's what the original
  // (pre-2026-09) version of this function did for this case — a silent
  // no-op, letting the caller proceed exactly as if nothing needed
  // finishing, rather than misrouting a session-less request into the
  // business-onboarding flow.
  if (!user) return "already_set_up";

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (profile) return "already_set_up";

  const meta = user.user_metadata as Record<string, unknown>;
  const pendingBusinessName =
    typeof meta.pending_business_name === "string" ? meta.pending_business_name : null;

  // No pending business metadata — could be a genuinely new Google/Apple
  // sign-in (the common case now) or some future non-business flow
  // (e.g. a staff-invite acceptance) that the caller knows to route
  // differently. Either way, this function has nothing to register.
  if (!pendingBusinessName) return "needs_business_name";

  const { error } = await supabase.rpc("register_business", {
    p_business_name: pendingBusinessName,
    p_owner_first_name: typeof meta.first_name === "string" ? meta.first_name : "",
    p_owner_last_name: typeof meta.last_name === "string" ? meta.last_name : "",
    p_phone: typeof meta.pending_business_phone === "string" ? meta.pending_business_phone : null,
  });

  if (error) {
    throw new Error(`register_business failed: ${error.message}`);
  }

  return "created_business";
}