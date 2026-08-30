"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import { Button, SubmitButton } from "@/components/ui/button";
import { signInCashier, type FormState } from "./actions";

const initialState: FormState = {};

export interface TillCashier {
  id: string;
  name: string;
  lockedUntil: string | null;
}

/**
 * Who is at the counter. The device stays signed in all day; this says
 * which colleague is serving, so each sale records a real person.
 *
 * Deliberately a keypad rather than a text field: this is used standing
 * up, often on a phone, and a numeric keypad with big targets is faster
 * and harder to mistype than a keyboard.
 */
export function PinPad({ cashiers }: { cashiers: TillCashier[] }) {
  const [state, formAction] = useFormState(signInCashier, initialState);
  const [cashierId, setCashierId] = useState("");
  const [pin, setPin] = useState("");

  const selected = cashiers.find((c) => c.id === cashierId);
  const lockedUntil = selected?.lockedUntil ? new Date(selected.lockedUntil) : null;
  const isLocked = lockedUntil !== null && lockedUntil > new Date();

  if (cashiers.length === 0) {
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-neutral-200 p-8 text-center dark:border-neutral-800">
        <h1 className="text-xl font-semibold">Nobody can sign in yet</h1>
        <p className="mt-2 text-sm text-neutral-500">
          The till identifies who made each sale by a short PIN. Set one under{" "}
          <span className="font-medium">My PIN</span>, then come back here.
        </p>
      </div>
    );
  }

  if (!cashierId) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Who&apos;s at the till?</h1>
          <p className="text-neutral-500">Pick your name to start serving.</p>
        </div>
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {cashiers.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setCashierId(c.id)}
                  className="min-h-[56px] w-full px-5 py-4 text-left font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                >
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="mx-auto flex max-w-xs flex-col gap-4" noValidate>
      <input type="hidden" name="cashierId" value={cashierId} />
      <input type="hidden" name="pin" value={pin} />

      <div className="text-center">
        <h1 className="text-2xl font-semibold">{selected?.name}</h1>
        <p className="text-neutral-500">Enter your PIN</p>
      </div>

      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-center text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
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

      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          setCashierId("");
          setPin("");
        }}
      >
        Someone else
      </Button>
    </form>
  );
}
