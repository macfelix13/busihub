"use client";

import Link from "next/link";
import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/button";
import { requestPasswordReset, type ResetPasswordState } from "./actions";

const initialState: ResetPasswordState = {};

export default function ResetPasswordPage() {
  const [state, formAction] = useFormState(requestPasswordReset, initialState);

  if (state.submitted) {
    return (
      <div className="text-center">
        <h1 className="mb-2 text-xl font-semibold">Check your email</h1>
        <p className="text-sm text-neutral-500 dark:text-ink-muted">
          If an account exists for that address, we&apos;ve sent a link to reset your password.
        </p>
      </div>
    );
  }

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Reset your password</h1>
      <p className="mb-6 text-sm text-neutral-500 dark:text-ink-muted">We&apos;ll email you a link to choose a new one.</p>

      <form action={formAction} className="flex flex-col gap-4" noValidate>
        {state.error ? (
          <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {state.error}
          </p>
        ) : null}
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        <SubmitButton pendingText="Sending…" className="w-full">
          Send reset link
        </SubmitButton>
      </form>

      <p className="mt-6 text-center text-sm text-neutral-500 dark:text-ink-muted">
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  );
}