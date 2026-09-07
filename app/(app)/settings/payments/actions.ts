"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { paystackSettingsSchema, keyMode } from "@/lib/validation/payments";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";
import { encryptSecret, secretLast4 } from "@/lib/crypto/secret-box";
import { loadPaystackCredentials } from "@/lib/paystack/client";
import { testConnection } from "@/lib/paystack/connection-test";

export interface PaymentSettingsFormState {
  error?: string;
  success?: boolean;
  fieldErrors?: Record<string, string>;
}

/**
 * Records a change to this business's payment settings through the one
 * sanctioned audit write path (log_audit_event, 0008). Best-effort on
 * purpose: by the time this runs, the actual settings change has already
 * succeeded, and a logging hiccup must never make that look like it
 * failed — so a failure here is logged to the server console and nothing
 * else.
 */
async function logPaymentSettingsEvent(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  businessId: string,
  action: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await supabase.rpc("log_audit_event", {
    p_business_id: businessId,
    p_branch_id: null,
    p_action: action,
    p_resource_type: "business_payment_settings",
    p_resource_id: null,
    p_metadata: metadata,
  });
  if (error) {
    console.error("logPaymentSettingsEvent: log_audit_event failed", { action, error });
  }
}

export async function updatePaystackSettings(
  _prevState: PaymentSettingsFormState,
  formData: FormData
): Promise<PaymentSettingsFormState> {
  const parsed = paystackSettingsSchema.safeParse({
    secretKey: formData.get("secretKey"),
    publicKey: formData.get("publicKey"),
    momoEnabled: formData.get("momoEnabled") === "on",
    confirmLive: formData.get("confirmLive") === "on",
  });

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await getCurrentBusinessId(supabase);
    await requirePermission(supabase, businessId, PERMISSIONS.BUSINESS_MANAGE);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("updatePaystackSettings: permission lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { secretKey, publicKey, momoEnabled } = parsed.data;
  const hasNewSecret = Boolean(secretKey && secretKey.length > 0);

  // Is there already a key stored? Read through the ordinary client,
  // which cannot see the ciphertext — only whether one exists. Nothing on
  // this path ever needs to read the secret back.
  const { data: existing } = await supabase
    .from("business_payment_settings")
    .select("business_id, paystack_secret_last4")
    .eq("business_id", businessId)
    .maybeSingle();

  const row = existing as { business_id: string; paystack_secret_last4: string | null } | null;

  if (!row && !hasNewSecret) {
    return {
      error: "Paste your Paystack secret key to connect the account.",
      fieldErrors: { secretKey: "Required the first time you connect." },
    };
  }

  // Turning mobile money on without a key stored would offer the cashier
  // a payment method that cannot work.
  if (momoEnabled && !hasNewSecret && !row?.paystack_secret_last4) {
    return {
      error: "Add a secret key before switching mobile money on.",
      fieldErrors: { secretKey: "Required to take mobile money." },
    };
  }

  let cipher: string | null = null;
  if (hasNewSecret && secretKey) {
    try {
      cipher = encryptSecret(secretKey);
    } catch (err) {
      // Almost always PAYSTACK_KEY_ENCRYPTION_KEY missing or the wrong
      // length. Storing the key in the clear instead is not an option, so
      // this fails rather than degrading.
      console.error("updatePaystackSettings: could not encrypt the secret key", err);
      return { error: "This server isn't configured to store payment keys. Contact your administrator." };
    }
  }

  const payload = {
    paystack_public_key: publicKey,
    // 'live' is read off the key itself rather than asked for, so a shop
    // cannot believe it is taking real money when it is not.
    is_live: keyMode(publicKey) === "live",
    momo_enabled: momoEnabled,
    ...(cipher && secretKey
      ? { paystack_secret_cipher: cipher, paystack_secret_last4: secretLast4(secretKey), configured_at: new Date().toISOString() }
      : {}),
  };

  const { error } = row
    ? await supabase.from("business_payment_settings").update(payload).eq("business_id", businessId)
    : await supabase.from("business_payment_settings").insert({ business_id: businessId, ...payload });

  if (error) {
    console.error("updatePaystackSettings: write failed", error);
    return { error: "Couldn't save your payment settings. Please try again." };
  }

  await logPaymentSettingsEvent(supabase, businessId, row ? "payment_settings.updated" : "payment_settings.connected", {
    momo_enabled: momoEnabled,
    is_live: keyMode(publicKey) === "live",
    secret_changed: hasNewSecret,
  });

  revalidatePath("/settings/payments");
  return { success: true };
}

/** Disconnects the account: the stored key is cleared, not just disabled. */
export async function disconnectPaystack(): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, PERMISSIONS.BUSINESS_MANAGE);

  const { error } = await supabase
    .from("business_payment_settings")
    .update({
      paystack_secret_cipher: null,
      paystack_secret_last4: null,
      paystack_public_key: null,
      momo_enabled: false,
      configured_at: null,
    })
    .eq("business_id", businessId);

  if (error) {
    console.error("disconnectPaystack: write failed", error);
    throw new Error("Couldn't disconnect Paystack. Please try again.");
  }

  await logPaymentSettingsEvent(supabase, businessId, "payment_settings.disconnected");

  revalidatePath("/settings/payments");
}

/**
 * Issues a new webhook_identifier (migration 0047), immediately replacing
 * the old one — the old URL, wherever it is pasted, stops meaning
 * anything from this moment on. The database function
 * (regenerate_paystack_webhook_identifier) does the actual write and the
 * permission check — there is no UPDATE grant on the column at all — so
 * this just calls it and records the change.
 */
export async function regenerateWebhookIdentifier(): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, PERMISSIONS.BUSINESS_MANAGE);

  const { error } = await supabase.rpc("regenerate_paystack_webhook_identifier", {
    p_business_id: businessId,
  });

  if (error) {
    console.error("regenerateWebhookIdentifier: rpc failed", error);
    if (error.code === "P0001" && error.message) {
      throw new Error(error.message);
    }
    throw new Error("Couldn't regenerate the webhook URL. Please try again.");
  }

  await logPaymentSettingsEvent(supabase, businessId, "payment_settings.webhook_regenerated");

  revalidatePath("/settings/payments");
}

export interface ConnectionTestState {
  ok: boolean;
  message: string;
}

/**
 * "Test connection" on the settings page. Read-only — it proves the
 * stored key actually authenticates with Paystack (lib/paystack/client's
 * testConnection) and reports back a plain yes/no, never the key. Gated
 * the same way as everything else on this page: only someone who could
 * already see and change these settings can trigger a check against them.
 */
export async function testPaystackConnection(): Promise<ConnectionTestState> {
  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await getCurrentBusinessId(supabase);
    await requirePermission(supabase, businessId, PERMISSIONS.BUSINESS_MANAGE);
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, message: err.message };
    console.error("testPaystackConnection: permission lookup failed", err);
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  const credentials = await loadPaystackCredentials(businessId);
  if (!credentials) {
    return { ok: false, message: "Connect a Paystack account first, then test it." };
  }

  return testConnection(credentials);
}