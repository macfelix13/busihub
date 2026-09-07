"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/button";
import type { PaymentSettingsFormState } from "./actions";
import { updatePaystackSettings } from "./actions";
import { TestConnectionButton } from "./test-connection-button";
import { RegenerateWebhookButton } from "./regenerate-webhook-button";

const initialState: PaymentSettingsFormState = {};

interface PaystackFormProps {
  publicKey: string | null;
  secretLast4: string | null;
  momoEnabled: boolean;
  isLive: boolean;
  webhookUrl: string;
}

export function PaystackForm({ publicKey, secretLast4, momoEnabled, isLive, webhookUrl }: PaystackFormProps) {
  const [state, formAction] = useFormState(updatePaystackSettings, initialState);
  const [secretKeyValue, setSecretKeyValue] = useState("");
  const connected = Boolean(secretLast4);
  // Purely for showing the confirmation checkbox at the right moment —
  // the schema (lib/validation/payments.ts) makes the same check
  // server-side regardless of what this client state thinks.
  const isEnteringLiveKey = secretKeyValue.trim().startsWith("sk_live_");

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="rounded-xl bg-green-50 px-3.5 py-2.5 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          Saved.
        </p>
      ) : null}

      {connected ? (
        <div className="rounded-xl border border-neutral-200 px-3.5 py-3 text-sm dark:border-neutral-800">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Connected</span>
            <span
              className={
                isLive
                  ? "rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950 dark:text-green-300"
                  : "rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
              }
            >
              {isLive ? "Live — real money" : "Test mode"}
            </span>
          </div>
          <p className="mt-1 text-neutral-500">
            Secret key ending <span className="font-mono">…{secretLast4}</span>. Leave the box below empty to keep it.
          </p>
          <div className="mt-3">
            <TestConnectionButton />
          </div>
        </div>
      ) : null}

      <Field
        label="Public key"
        name="publicKey"
        defaultValue={publicKey ?? ""}
        placeholder="pk_test_…"
        autoComplete="off"
        spellCheck={false}
        error={state.fieldErrors?.publicKey}
      />

      <Field
        label={connected ? "New secret key (optional)" : "Secret key"}
        name="secretKey"
        type="password"
        placeholder="sk_test_…"
        autoComplete="off"
        spellCheck={false}
        error={state.fieldErrors?.secretKey}
        onChange={(e) => setSecretKeyValue(e.target.value)}
      />
      <p className="-mt-3 text-sm text-neutral-500">
        Both are in your Paystack dashboard under Settings → API Keys &amp; Webhooks. The secret key is encrypted
        before it is stored and is never shown again — not even here.
      </p>

      {isEnteringLiveKey ? (
        <div className="-mt-1 flex flex-col gap-1.5">
          <label className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
            <input
              type="checkbox"
              name="confirmLive"
              className="mt-0.5 h-5 w-5 rounded border-neutral-300 text-brand-600 focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <span>
              <span className="font-medium text-amber-900 dark:text-amber-200">This is a LIVE key</span>
              <span className="block text-amber-900/80 dark:text-amber-200/80">
                Mobile money charges will take real money from real customers the moment this is saved and switched
                on. I understand and want to connect it.
              </span>
            </span>
          </label>
          {state.fieldErrors?.confirmLive ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {state.fieldErrors.confirmLive}
            </p>
          ) : null}
        </div>
      ) : null}

      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="momoEnabled"
          defaultChecked={momoEnabled}
          className="mt-0.5 h-5 w-5 rounded border-neutral-300 text-brand-600 focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <span>
          <span className="font-medium text-neutral-800 dark:text-neutral-200">Take mobile money at the till</span>
          <span className="block text-neutral-500">
            Cashiers can charge a customer&apos;s MTN, Telecel or AT number. The customer approves it on their own
            phone.
          </span>
        </span>
      </label>

      <div className="rounded-xl bg-neutral-100 px-3.5 py-3 text-sm dark:bg-neutral-800">
        <p className="font-medium text-neutral-800 dark:text-neutral-200">Your webhook URL</p>
        <p className="mt-1 break-all font-mono text-xs text-neutral-600 dark:text-neutral-300">{webhookUrl}</p>
        <p className="mt-2 text-neutral-500">
          Paste this into Paystack under Settings → API Keys &amp; Webhooks. Without it a customer can approve a
          payment and the sale will sit unfinished until someone checks it.
        </p>
        {connected ? (
          <div className="mt-3">
            <RegenerateWebhookButton />
          </div>
        ) : null}
      </div>

      <SubmitButton pendingText="Saving…" className="self-start px-6">
        Save
      </SubmitButton>
    </form>
  );
}