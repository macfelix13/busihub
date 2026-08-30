import { z } from "zod";

/**
 * Connecting a shop's own Paystack account.
 *
 * The keys are validated by shape here so an obvious mistake — a public
 * key pasted into the secret box, test and live keys mixed, a stray space
 * from copying out of the dashboard — is caught before it becomes a
 * failed charge with a customer standing at the counter.
 */

const SECRET_PATTERN = /^sk_(test|live)_[A-Za-z0-9]{10,}$/;
const PUBLIC_PATTERN = /^pk_(test|live)_[A-Za-z0-9]{10,}$/;

export const MOMO_NETWORKS = [
  { value: "mtn", label: "MTN MoMo" },
  { value: "vod", label: "Telecel Cash" },
  { value: "atl", label: "AT Money" },
] as const;

export type MomoNetworkValue = (typeof MOMO_NETWORKS)[number]["value"];

export function momoNetworkLabel(value: string): string {
  return MOMO_NETWORKS.find((n) => n.value === value)?.label ?? value;
}

/** 'sk_live_…' / 'pk_live_…' means real money. Read, never asked. */
export function keyMode(key: string): "live" | "test" | null {
  if (key.startsWith("sk_live_") || key.startsWith("pk_live_")) return "live";
  if (key.startsWith("sk_test_") || key.startsWith("pk_test_")) return "test";
  return null;
}

export const paystackSettingsSchema = z
  .object({
    // Blank means "leave the key that is already stored alone" — the
    // form never receives the existing secret back, so it cannot resend
    // it, and requiring it on every edit would mean re-pasting a secret
    // to change a checkbox.
    secretKey: z.string().trim().optional().or(z.literal("")),
    publicKey: z
      .string()
      .trim()
      .min(1, "Paste your Paystack public key.")
      .regex(PUBLIC_PATTERN, "That doesn't look like a Paystack public key (it starts with pk_test_ or pk_live_)."),
    momoEnabled: z.boolean(),
  })
  .superRefine((data, ctx) => {
    const secret = data.secretKey ?? "";
    if (secret.length > 0) {
      if (!SECRET_PATTERN.test(secret)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          // Named specifically, because pasting the public key into both
          // boxes is by far the most common way to get this wrong.
          message: secret.startsWith("pk_")
            ? "That's your public key. The secret key starts with sk_test_ or sk_live_."
            : "That doesn't look like a Paystack secret key (it starts with sk_test_ or sk_live_).",
          path: ["secretKey"],
        });
        return;
      }
      if (keyMode(secret) !== keyMode(data.publicKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "One of these is a test key and the other is live. Use a matching pair.",
          path: ["secretKey"],
        });
      }
    }
  });

export type PaystackSettingsInput = z.infer<typeof paystackSettingsSchema>;
