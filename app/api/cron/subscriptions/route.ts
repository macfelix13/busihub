import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { cronSecret } from "@/lib/env";

/**
 * Phase 18 (Subscriptions & entitlements enforcement) — drives the one
 * subscription status transition that needs no human judgment call: a
 * trial running out, and its grace period after that (past_due ->
 * expired), plus fulfilling a cancellation a Super Admin already
 * scheduled. See supabase/migrations/0058_entitlements_enforcement.sql's
 * own file header for exactly what this does and does not automate, and
 * for why this is a Vercel Cron Job hitting this route rather than a
 * Supabase Edge Function — an earlier design note in
 * docs/ARCHITECTURE.md's Section 9 said Edge Function; this route (and
 * vercel.json's `crons` entry) is the actual, shipped mechanism, chosen
 * because it needed no new deployment surface on top of the Next.js/
 * Vercel stack everything else already runs on.
 *
 * Vercel signs every request IT sends to a scheduled route with
 * `Authorization: Bearer ${CRON_SECRET}` automatically, once CRON_SECRET
 * is set as a project environment variable. Anyone else calling this URL
 * without that exact header gets 401 — same defense-in-depth posture as
 * the Paystack webhook route checking its own signature before acting on
 * anything.
 */
export async function GET(request: Request) {
  const secret = cronSecret();
  if (!secret) {
    // Fails closed: refuses every caller, including Vercel's own cron,
    // rather than ever running unauthenticated. Logged, not silent, so a
    // missing env var in a new environment is discoverable from logs
    // rather than looking like a cron that "just never does anything".
    console.error("GET /api/cron/subscriptions: CRON_SECRET is not configured");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("process_subscription_lifecycle");

  if (error) {
    console.error("GET /api/cron/subscriptions: process_subscription_lifecycle failed", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, summary: data });
}