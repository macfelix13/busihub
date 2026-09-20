"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { supabaseAppUrl } from "@/lib/env";
import { Button } from "@/components/ui/button";

/**
 * "Continue with Google" (2026-09). This is a plain onClick handler, not
 * a Server Action bound to a <form> the way every other auth action in
 * this app is — signInWithOAuth() has to run in the BROWSER (it does a
 * full-page redirect to Google, which a server action can't initiate),
 * so this uses lib/supabase/client.ts's browser client, the one place in
 * the codebase that's meant to be constructed from a Client Component.
 *
 * redirectTo points at the same app/auth/confirm/route.ts that already
 * handles the email-confirmation and password-reset links' PKCE `code`
 * exchange — @supabase/ssr's signInWithOAuth() uses that exact shape, so
 * no new callback route was needed. What IS new: a brand-new Google
 * sign-in has no business name yet (Google only ever hands back a
 * name/email/photo), so that route now sends a first-time sign-in on to
 * app/(auth)/onboarding/business instead of straight to `next` — see
 * that route's own comment.
 *
 * `next` mirrors the email/password forms' own default (redirect to
 * /dashboard once signed in; app/(app)/layout.tsx's own guard sends a
 * business-less profile on to /admin from there, same as every other
 * sign-in path).
 */
export function GoogleSignInButton({ label, next = "/dashboard" }: { label: string; next?: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${supabaseAppUrl()}/auth/confirm?next=${encodeURIComponent(next)}`,
      },
    });

    if (oauthError) {
      console.error("GoogleSignInButton: signInWithOAuth failed", oauthError);
      setError("Couldn't start Google sign-in. Please try again.");
      setLoading(false);
    }
    // On success the browser navigates away to Google immediately —
    // nothing else runs here, and there's no "success" state to show.
  }

  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      ) : null}
      <Button type="button" variant="secondary" onClick={handleClick} loading={loading} className="w-full">
        {loading ? null : (
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="flex-shrink-0">
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" />
            <path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.55 0 9s.348 2.825.957 4.039l3.007-2.332z" />
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.167 6.656 3.58 9 3.58z" />
          </svg>
        )}
        {loading ? "Redirecting…" : label}
      </Button>
    </div>
  );
}