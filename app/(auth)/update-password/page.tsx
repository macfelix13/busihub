"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";

/**
 * Reached via app/auth/confirm/route.ts, which exchanges the PKCE `code`
 * from the password-reset email link for a session server-side (cookies
 * are already set by the time this page renders — @supabase/ssr's PKCE
 * flow does NOT auto-detect a session from the URL the way the older
 * implicit flow's #access_token fragment did). This page just needs to
 * call updateUser() using the browser client, which reads that same
 * cookie-based session.
 */
export default function UpdatePasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      setError("That link may have expired. Request a new password reset email and try again.");
      return;
    }

    router.push("/dashboard");
  }

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Choose a new password</h1>
      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4" noValidate>
        {error ? (
          <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
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
          {submitting ? "Updating…" : "Update password"}
        </Button>
      </form>
    </>
  );
}