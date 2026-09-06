"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import { Button, SubmitButton } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { verifyOwnPin, switchTillUser, type FormState } from "./actions";

const initialState: FormState = {};

export interface TillCashier {
  id: string;
  name: string;
  hasPin: boolean;
  lockedUntil: string | null;
}

export interface TillColleague {
  id: string;
  name: string;
  email: string | null;
}

type Mode = "pin" | "switch-pick" | "switch-password";

/**
 * The till's lock screen. Confirms the account that is ALREADY signed
 * into this browser is genuinely the person standing at the counter —
 * it never lets you claim to be someone else (0039). Deliberately a
 * keypad rather than a text field: this is used standing up, often on a
 * phone, and a numeric keypad with big targets is faster and harder to
 * mistype than a keyboard.
 *
 * Handing the till to a colleague is a separate, explicit step — "Switch
 * user" — that asks for THEIR password, i.e. actually signs the browser
 * in as them (the same mechanism as the login page), rather than typing
 * a PIN on someone else's behalf.
 */
export function PinPad({ cashier, colleagues }: { cashier: TillCashier; colleagues: TillColleague[] }) {
  const [mode, setMode] = useState<Mode>("pin");
  const [pin, setPin] = useState("");
  const [colleagueId, setColleagueId] = useState("");
  const [password, setPassword] = useState("");

  const [pinFormState, pinFormAction] = useFormState(verifyOwnPin, initialState);
  const [switchFormState, switchFormAction] = useFormState(switchTillUser, initialState);

  const lockedUntil = cashier.lockedUntil ? new Date(cashier.lockedUntil) : null;
  const isLocked = lockedUntil !== null && lockedUntil > new Date();
  const colleague = colleagues.find((c) => c.id === colleagueId);

  if (mode === "switch-pick") {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Switch user</h1>
          <p className="text-neutral-500">Pick who&apos;s taking over the till.</p>
        </div>
        {colleagues.length === 0 ? (
          <p className="rounded-xl border border-neutral-200 px-3.5 py-8 text-center text-sm text-neutral-500 dark:border-neutral-800">
            There&apos;s nobody else active on this account to switch to.
          </p>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {colleagues.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setColleagueId(c.id);
                      setPassword("");
                      setMode("switch-password");
                    }}
                    className="min-h-[56px] w-full px-5 py-4 text-left font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                  >
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Button type="button" variant="ghost" onClick={() => setMode("pin")}>
          Back
        </Button>
      </div>
    );
  }

  if (mode === "switch-password" && colleague) {
    return (
      <form
        action={switchFormAction}
        className="mx-auto flex max-w-xs flex-col gap-4"
        noValidate
      >
        <input type="hidden" name="email" value={colleague.email ?? ""} />

        <div className="text-center">
          <h1 className="text-2xl font-semibold">{colleague.name}</h1>
          <p className="text-neutral-500">Enter their password to switch.</p>
        </div>

        {switchFormState.error ? (
          <p
            role="alert"
            className="rounded-xl bg-red-50 px-3.5 py-2.5 text-center text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {switchFormState.error}
          </p>
        ) : null}

        {!colleague.email ? (
          <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-center text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            This account has no email on file, so it can&apos;t sign in here.
          </p>
        ) : (
          <Field
            label="Password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={switchFormState.fieldErrors?.password}
          />
        )}

        <SubmitButton pendingText="Switching…" className="min-h-[52px] text-base" disabled={!colleague.email}>
          Switch to {colleague.name}
        </SubmitButton>

        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setColleagueId("");
            setPassword("");
            setMode("switch-pick");
          }}
        >
          Back
        </Button>
      </form>
    );
  }

  // mode === "pin"
  if (!cashier.hasPin) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <div className="mx-auto max-w-md rounded-2xl border border-neutral-200 p-8 text-center dark:border-neutral-800">
          <h1 className="text-xl font-semibold">You don&apos;t have a PIN yet</h1>
          <p className="mt-2 text-sm text-neutral-500">
            The till confirms it&apos;s really you with a short PIN before you can start selling. Set one under{" "}
            <span className="font-medium">My PIN</span>, then come back here.
          </p>
        </div>
        {colleagues.length > 0 ? (
          <Button type="button" variant="ghost" onClick={() => setMode("switch-pick")}>
            Switch user instead
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <form action={pinFormAction} className="mx-auto flex max-w-xs flex-col gap-4" noValidate>
      <input type="hidden" name="pin" value={pin} />

      <div className="text-center">
        <h1 className="text-2xl font-semibold">{cashier.name}</h1>
        <p className="text-neutral-500">Enter your PIN to start serving.</p>
      </div>

      {pinFormState.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-center text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {pinFormState.error}
        </p>
      ) : null}

      {isLocked ? (
        <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-center text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Locked after too many wrong attempts until{" "}
          {lockedUntil.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.
        </p>
      ) : null}

      {/* The PIN itself is never shown, only its length. */}
      <div className="flex justify-center gap-3 py-2" aria-label={`${pin.length} digits entered`}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={`h-3 w-3 rounded-full ${
              i < pin.length ? "bg-brand-600" : "bg-neutral-200 dark:bg-neutral-700"
            }`}
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <Button
            key={d}
            type="button"
            variant="secondary"
            className="min-h-[64px] text-xl"
            onClick={() => setPin((p) => (p.length < 6 ? p + d : p))}
          >
            {d}
          </Button>
        ))}
        <Button type="button" variant="ghost" className="min-h-[64px]" onClick={() => setPin("")}>
          Clear
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="min-h-[64px] text-xl"
          onClick={() => setPin((p) => (p.length < 6 ? p + "0" : p))}
        >
          0
        </Button>
        <Button type="button" variant="ghost" className="min-h-[64px]" onClick={() => setPin((p) => p.slice(0, -1))}>
          ←
        </Button>
      </div>

      <SubmitButton pendingText="Checking…" className="min-h-[52px] text-base" disabled={pin.length < 4}>
        Start serving
      </SubmitButton>

      {colleagues.length > 0 ? (
        <Button type="button" variant="ghost" onClick={() => setMode("switch-pick")}>
          Not {cashier.name}? Switch user
        </Button>
      ) : null}
    </form>
  );
}