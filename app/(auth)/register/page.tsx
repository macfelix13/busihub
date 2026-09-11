"use client";

import Link from "next/link";
// React 18 / Next 14: the form-state hook lives in "react-dom" as
// useFormState (renamed to useActionState in React 19 / Next 15 — this
// project pins React 18.3.1, see package.json).
import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/button";
import { registerBusiness, type RegisterFormState } from "./actions";

const initialState: RegisterFormState = {};

export default function RegisterPage() {
  const [state, formAction] = useFormState(registerBusiness, initialState);

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Register your business</h1>
      <p className="mb-6 text-sm text-neutral-500 dark:text-ink-muted">Start your 14-day free trial — no card required.</p>

      <form action={formAction} className="flex flex-col gap-4" noValidate>
        {state.error ? (
          <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {state.error}
          </p>
        ) : null}

        <Field
          label="Business name"
          name="businessName"
          required
          autoComplete="organization"
          error={state.fieldErrors?.businessName}
        />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Your first name" name="ownerFirstName" required autoComplete="given-name" error={state.fieldErrors?.ownerFirstName} />
          <Field label="Your last name" name="ownerLastName" autoComplete="family-name" error={state.fieldErrors?.ownerLastName} />
        </div>

        <Field label="Email" name="email" type="email" required autoComplete="email" error={state.fieldErrors?.email} />
        <Field label="Phone (optional)" name="phone" type="tel" autoComplete="tel" error={state.fieldErrors?.phone} />
        <Field
          label="Password"
          name="password"
          type="password"
          required
          autoComplete="new-password"
          error={state.fieldErrors?.password}
        />
        <p className="-mt-2 text-xs text-neutral-500 dark:text-ink-muted">At least 10 characters, with an uppercase letter, lowercase letter, and a number.</p>

        <SubmitButton pendingText="Creating your account…" className="mt-2 w-full">
          Create account
        </SubmitButton>
      </form>

      <p className="mt-6 text-center text-sm text-neutral-500 dark:text-ink-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}