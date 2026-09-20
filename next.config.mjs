import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // https://challenges.cloudflare.com: Turnstile's widget script
      // (components/auth/turnstile-widget.tsx, 2026-09 20-point audit,
      // gap #12) — both script-src and frame-src are required per
      // Cloudflare's own docs (developers.cloudflare.com/turnstile/reference/content-security-policy),
      // since the widget loads a script here AND renders its challenge in
      // an iframe from the same origin. No connect-src entry needed —
      // that's only required for Turnstile's optional pre-clearance mode,
      // which this app doesn't use.
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.paystack.co",
      "frame-src https://checkout.paystack.com https://challenges.cloudflare.com",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig = {
  reactStrictMode: true,

  // Pin the workspace root to THIS folder.
  //
  // Without it Next infers the root by walking up looking for a lockfile,
  // and on a drive where that walk reaches the top it settles on the drive
  // itself. The symptom is unmistakable in `next dev`:
  //
  //   Watchpack Error (initial scan): EINVAL: invalid argument,
  //   lstat 'F:\System Volume Information'
  //
  // — the file watcher scanning the entire drive, including Windows'
  // system folders, on startup and on every change. That is the single
  // biggest cause of multi-minute first compiles here.
  turbopack: {
    root: projectRoot,
  },
  // Same reasoning for the production build's file tracing, which walks
  // the tree to decide what to bundle.
  outputFileTracingRoot: projectRoot,
  // Next.js 16 removed the `next lint` command (and this `eslint` config
  // block along with it) — see package.json's "lint" script, which now
  // runs `eslint .` directly; scope/ignores are handled in
  // eslint.config.mjs instead of here.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;