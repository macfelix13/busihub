"use client";

import Script from "next/script";
import { turnstileSiteKey } from "@/lib/env";

/**
 * Cloudflare Turnstile's implicit-render widget (2026-09 20-point audit,
 * gap #12 — bot protection). Pairs with lib/turnstile.ts's server-side
 * verifyTurnstileToken() — see that file's comment for which three forms
 * use this and why.
 *
 * Implicit rendering on purpose: the plain `<div class="cf-turnstile">`
 * below is auto-discovered by Cloudflare's script once it loads, and once
 * solved it injects its OWN hidden `<input name="cf-turnstile-response">`
 * into the surrounding <form> — no onSubmit handler, no callback, no
 * state to wire up on this end. That matters here specifically because
 * every one of these three pages already submits through a plain
 * `<form action={formAction}>` bound to a Server Action (React 18's
 * useFormState, not client-side fetch) — this widget drops into that
 * exact shape with nothing else to change.
 *
 * Renders nothing at all when NEXT_PUBLIC_TURNSTILE_SITE_KEY isn't set —
 * see that function's own comment in lib/env.ts. A page with no widget
 * submits with no `cf-turnstile-response` field, which
 * verifyTurnstileToken() already treats as "not configured yet" on the
 * server side too, so the two stay in sync without duplicating the
 * on/off logic in two places.
 */
export function TurnstileWidget() {
  const siteKey = turnstileSiteKey();

  if (!siteKey) {
    return null;
  }

  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="afterInteractive" async defer />
      <div className="cf-turnstile" data-sitekey={siteKey} data-theme="auto" />
    </>
  );
}