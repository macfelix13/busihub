"use client";

import { StatusToggleButton } from "../../products/status-toggle-button";
import { regenerateWebhookIdentifier } from "./actions";

/**
 * Replaces this shop's webhook_identifier (migration 0047) immediately —
 * the confirmation step exists because the OLD URL, wherever it is
 * pasted in Paystack, stops meaning anything the instant this succeeds.
 * Success just re-renders the page with the new URL (revalidatePath in
 * the action); there is nothing else for this component to show.
 */
export function RegenerateWebhookButton() {
  return (
    <StatusToggleButton
      action={regenerateWebhookIdentifier}
      label="Regenerate"
      pendingLabel="Regenerating…"
      variant="secondary"
      confirm={{
        title: "Regenerate this webhook URL?",
        description:
          "The URL above will stop working immediately. Mobile money payments won't be confirmed automatically until you paste the new one into Paystack under Settings → API Keys & Webhooks.",
        confirmLabel: "Regenerate",
      }}
    />
  );
}