import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { finishPendingRegistrationIfNeeded } from "@/lib/auth/finish-pending-registration";

/**
 * PKCE code-exchange callback. @supabase/ssr's clients default to the PKCE
 * flow, so both the signup-confirmation email link and the password-reset
 * email link redirect back here with a `?code=` param that must be
 * exchanged for a session server-side (using the same cookie-bound client
 * that generated the original code_verifier) — the browser client does
 * NOT pick this up automatically the way it does with the older implicit
 * flow's #access_token fragment. Without this route, the email link
 * confirms the address (Supabase does that before redirecting) but never
 * actually signs the user in.
 *
 * `next` controls where to send the user afterward:
 *   - signUp() (app/(auth)/register/actions.ts) sets emailRedirectTo so
 *     this resolves with next=/dashboard, and we also finish
 *     register_business() here since this may be the first time a
 *     session exists for that user.
 *   - resetPasswordForEmail() (app/(auth)/reset-password/actions.ts) sets
 *     redirectTo so this resolves with next=/update-password.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (!code) {
    redirect("/login?error=missing_code");
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    redirect("/login?error=link_expired");
  }

  try {
    await finishPendingRegistrationIfNeeded(supabase);
  } catch {
    // The session is valid at this point (exchange succeeded) — send the
    // user somewhere they can retry rather than stranding them on an
    // error page. Logging in again re-runs this same fallback (see
    // app/(auth)/login/actions.ts) once they have a session either way.
    redirect("/login?error=setup_incomplete");
  }

  redirect(next);
}
