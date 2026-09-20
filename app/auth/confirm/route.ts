import { redirect } from "next/navigation";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { finishPendingRegistrationIfNeeded } from "@/lib/auth/finish-pending-registration";

/**
 * Email-confirmation callback, reached from both the "Confirm signup" and
 * "Reset Password" emails. Handles two different link shapes:
 *
 * - `?token_hash=...&type=...` — what both of those email templates send
 *   today (Authentication > Emails in the Supabase dashboard), verified
 *   here with verifyOtp(). This is Supabase's own documented pattern for a
 *   custom Next.js confirmation route, and it replaced those templates'
 *   original `{{ .ConfirmationURL }}` variable. That variable always
 *   routes through Supabase's own `/auth/v1/verify` endpoint, which
 *   replies with the session appended as a URL `#access_token=...`
 *   fragment no matter what flow this app's own Supabase client asks for
 *   — and a fragment is never sent to any server (browsers keep it
 *   client-side only), so this route never even saw those requests: the
 *   browser just landed on the configured Site URL with an inert fragment
 *   attached, which looked exactly like the link dropping the user on the
 *   marketing homepage instead of signing them in. See this fix's
 *   docs/ARCHITECTURE.md changelog entry for the full diagnosis.
 * - `?code=...` — the PKCE code-exchange shape this route originally only
 *   supported. Kept as a fallback in case anything else ever links here
 *   that way (@supabase/ssr's clients default to PKCE for flows like
 *   signInWithOAuth).
 *
 * `next` controls where to send the user afterward:
 *   - the "Confirm signup" template sets next=/dashboard, and we also
 *     finish register_business() here since this may be the first time a
 *     session exists for that user.
 *   - the "Reset Password" template sets next=/update-password.
 *   - Google/Apple sign-in (2026-09, `?code=` branch below) always lands
 *     here too — @supabase/ssr's signInWithOAuth() uses this exact PKCE
 *     code-exchange shape, which is why the `code` branch below was kept
 *     even before anything used it yet (see its own comment).
 *
 * A brand-new OAuth sign-in never has a pending_business_name the way an
 * email/password signUp() can (see app/(auth)/register/actions.ts) — the
 * provider only ever hands back a name/email/photo, never a business —
 * so finishPendingRegistrationIfNeeded() below can come back
 * "needs_business_name" here for the first time. When it does, `next` is
 * carried through the redirect instead of followed directly, so
 * app/(auth)/onboarding/business can send the user on to wherever they
 * were originally headed once they've named their business.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  const supabase = await createServerSupabaseClient();

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) {
      redirect("/login?error=link_expired");
    }
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      redirect("/login?error=link_expired");
    }
  } else {
    redirect("/login?error=missing_code");
  }

  let registrationStatus: Awaited<ReturnType<typeof finishPendingRegistrationIfNeeded>>;
  try {
    registrationStatus = await finishPendingRegistrationIfNeeded(supabase);
  } catch {
    // The session is valid at this point (verification/exchange
    // succeeded) — send the user somewhere they can retry rather than
    // stranding them on an error page. Logging in again re-runs this same
    // fallback (see app/(auth)/login/actions.ts) once they have a session
    // either way.
    redirect("/login?error=setup_incomplete");
  }

  if (registrationStatus === "needs_business_name") {
    redirect(`/onboarding/business?next=${encodeURIComponent(next)}`);
  }

  redirect(next);
}