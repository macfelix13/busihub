"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { testPaystackConnection } from "./actions";

/**
 * A read-only check, not a form submission — it lives outside the
 * settings <form> entirely so it can never be confused with saving new
 * keys, and pressing it twice in a row just asks Paystack twice.
 */
export function TestConnectionButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const onClick = () => {
    setResult(null);
    startTransition(async () => {
      const outcome = await testPaystackConnection();
      setResult(outcome);
    });
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <Button type="button" variant="secondary" loading={pending} onClick={onClick}>
        Test connection
      </Button>
      {result ? (
        <p
          role="status"
          className={result.ok ? "text-sm text-green-700 dark:text-green-300" : "text-sm text-red-700 dark:text-red-300"}
        >
          {result.ok ? "🟢 " : "🔴 "}
          {result.message}
        </p>
      ) : null}
    </div>
  );
}