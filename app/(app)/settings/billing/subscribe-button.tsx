"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { startPlanCheckout } from "./actions";

/**
 * Not a <form action={...}> like most buttons in this app — the action
 * returns a Paystack-hosted URL to send the WHOLE browser to, not a
 * result to render in place, so this calls it directly inside a
 * transition and redirects on success. window.location.href, not
 * next/navigation's redirect(), because the destination is an external
 * origin (checkout.paystack.com) — redirect() is for internal routes.
 *
 * `mode` (0062) only changes the button's own label — "Subscribe to X"
 * for a business with no active self-serve plan yet, "Switch to X" for
 * one already on a different Paystack-managed plan. startPlanCheckout()
 * and start_plan_checkout() (migration 0061/0062) handle both cases
 * identically; there is no separate "switch" code path to call.
 */
export function SubscribeButton({
  planId,
  planName,
  mode = "subscribe",
}: {
  planId: string;
  planName: string;
  mode?: "subscribe" | "switch";
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    startTransition(async () => {
      const result = await startPlanCheckout(planId);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.authorizationUrl) {
        window.location.href = result.authorizationUrl;
      }
    });
  };

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button type="button" variant="primary" loading={pending} onClick={onClick}>
        {mode === "switch" ? `Switch to ${planName}` : `Subscribe to ${planName}`}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}