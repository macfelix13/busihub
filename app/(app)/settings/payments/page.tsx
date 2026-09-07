import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { StatusToggleButton } from "../../products/status-toggle-button";
import { PaystackForm } from "./paystack-form";
import { disconnectPaystack } from "./actions";

export const metadata = { title: "Payment settings" };

interface SettingsRow {
  paystack_public_key: string | null;
  paystack_secret_last4: string | null;
  is_live: boolean;
  momo_enabled: boolean;
  webhook_identifier: string | null;
}

export default async function PaymentSettingsPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.BUSINESS_MANAGE);

  // Owner-only, like the rest of settings. Cosmetic — the Server Action
  // and the table's own policies both re-check it.
  if (!canManage) {
    redirect("/dashboard");
  }

  // Note what is NOT selected: paystack_secret_cipher. It is not
  // selectable by `authenticated` at all (migration 0022), and nothing on
  // this page needs it — only the server, decrypting it to call Paystack.
  const { data, error } = await supabase
    .from("business_payment_settings")
    .select("paystack_public_key, paystack_secret_last4, is_live, momo_enabled, webhook_identifier")
    .eq("business_id", businessId)
    .maybeSingle();

  if (error) {
    console.error("PaymentSettingsPage: query failed", error);
  }

  const settings = (data ?? null) as SettingsRow | null;

  // Before this shop has ever connected an account, there is no row and
  // so no webhook_identifier (migration 0047) yet — the businessId-shaped
  // URL shown here is only a preview in that case, replaced the moment
  // the first save assigns a real identifier. Once connected, the webhook
  // route recognises this fallback shape forever anyway (see
  // resolveBusinessIdFromWebhookParam), so nothing here can go stale.
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const webhookUrl = `${base}/api/webhooks/paystack/${settings?.webhook_identifier ?? businessId}`;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Payments</h1>
        <p className="text-neutral-500">
          Connect your own Paystack account to take mobile money. The money goes straight to you — Busihub never
          holds it.
        </p>
      </div>

      <PaystackForm
        publicKey={settings?.paystack_public_key ?? null}
        secretLast4={settings?.paystack_secret_last4 ?? null}
        momoEnabled={settings?.momo_enabled ?? false}
        isLive={settings?.is_live ?? false}
        webhookUrl={webhookUrl}
      />

      {settings?.paystack_secret_last4 ? (
        <div className="border-t border-neutral-200 pt-6 dark:border-neutral-800">
          <h2 className="font-semibold">Disconnect</h2>
          <p className="mt-1 max-w-prose text-sm text-neutral-500">
            Removes the stored keys and switches mobile money off. Sales already paid are untouched; any sale still
            waiting for a payment will have to be cancelled at the till.
          </p>
          <div className="mt-3">
            <StatusToggleButton
              action={disconnectPaystack}
              label="Disconnect Paystack"
              pendingLabel="Disconnecting…"
              variant="danger"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}