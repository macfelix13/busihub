"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";

type Stage = "checking" | "ready" | "invalid";

/**
 * Lands here from the staff-invite email (inviteStaff() in
 * app/(app)/settings/staff/actions.ts sets this as the invite's redirectTo).
 *
 * This can't reuse app/auth/confirm/route.ts. That route exchanges a PKCE
 * `?code=` query param for a session server-side, which works for the
 * signup-confirmation and password-reset links because those flows are
 * *initiated by the invitee's own browser* (signUp(), resetPasswordForEmail())
 * using a client configured for PKCE, which generates a matching
 * code_verifier the exchange needs.
 *
 * A staff invite is different: admin.auth.admin.inviteUserByEmail() is
 * called from the server by whoever is doing the inviting, not by the
 * invitee's browser — there's no code_verifier anywhere for a `?code=` to
 * pair with. Supabase falls back to the older implicit-flow style for this
 * case instead, appending the session directly as a URL #fragment
 * (#access_token=...&refresh_token=...&type=invite) rather than a query
 * param. Fragments are never sent to the server (the browser strips them
 * before the request even goes out), so only client-side code can read
 * this one — hence this being a full client component rather than a
 * Route Handler.
 *
 * An expired or already-used invite link redirects here with
 * #error=access_denied&error_code=otp_expired&... instead of tokens.
 */
export default function AcceptInvitePage() {
  const router = useRouter();
  const ran = useRef(false);
  const [stage, setStage] = useState<Stage>("checking");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // React can invoke effects twice in development (Strict Mode). Reading
    // and clearing the URL fragment is a one-shot operation, so guard it.
    if (ran.current) return;
    ran.current = true;

    const rawHash = window.location.hash;
    const hash = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
    const params = new URLSearchParams(hash);

    // Strip the tokens out of the visible URL immediately, whether or not
    // they're valid — they're sensitive and shouldn't linger in the
    // address bar or browser history.
    window.history.replaceState(null, "", window.location.pathname);

    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");

    if (params.get("error") || !accessToken || !refreshToken) {
      setStage("invalid");
      return;
    }

    const supabase = createClient();
    supabase.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then((result: { error: unknown }) => {
        setStage(result.error ? "invalid" : "ready");
      });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 10) {
      setError("Password must be at least 10 characters.");
      return;
    }

    setSubmitting(true);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setSubmitting(false);

    if (updateError) {
      setError("Something went wrong setting your password. Please try again.");
      return;
    }

    router.push("/dashboard");
  }

  if (stage === "checking") {
    return (
      <div className="text-center">
        <h1 className="mb-2 text-xl font-semibold">Confirming your invite…</h1>
        <p className="text-sm text-neutral-500">This will just take a moment.</p>
      </div>
    );
  }

  if (stage === "invalid") {
    return (
      <div className="text-center">
        <h1 className="mb-2 text-xl font-semibold">This invite link isn&apos;t valid</h1>
        <p className="text-sm text-neutral-500">
          It may have expired or already been used — invite links only work once. Ask your business
          owner or manager to send you a new invite from Settings → Staff.
        </p>
      </div>
    );
  }

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Welcome to Busihub</h1>
      <p className="mb-6 text-sm text-neutral-500">Choose a password to finish setting up your account.</p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        {error ? (
          <p
            role="alert"
            className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {error}
          </p>
        ) : null}
        <Field
          label="New password"
          name="password"
          type="password"
          required
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? "Setting password…" : "Set password and continue"}
        </Button>
      </form>
    </>
  );
}