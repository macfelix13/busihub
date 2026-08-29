"use client";

import Link from "next/link";
import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/button";
import { login, type LoginFormState } from "./actions";

const initialState: LoginFormState = {};

export default function LoginPage() {
  const [state, formAction] = useFormState(login, initialState);

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
      <p className="mb-6 text-sm text-neutral-500">Welcome back to Busihub.</p>

      <form action={formAction} className="flex flex-col gap-4" noValidate>
        {state.error ? (
          <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {state.error}
          </p>
        ) : null}

        <Field label="Email" name="email" type="email" required autoComplete="email" error={state.fieldErrors?.email} />
        <Field
          label="Password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          error={state.fieldErrors?.password}
        />

        <div className="flex justify-end">
          <Link href="/reset-password" className="text-sm font-medium text-brand-600 hover:underline">
            Forgot password?
          </Link>
        </div>

        <SubmitButton pendingText="Signing in…" className="mt-2 w-full">
          Sign in
        </SubmitButton>
      </form>

      <p className="mt-6 text-center text-sm text-neutral-500">
        Don&apos;t have an account?{" "}
        <Link href="/register" className="font-medium text-brand-600 hover:underline">
          Register your business
        </Link>
      </p>
    </>
  );
}
