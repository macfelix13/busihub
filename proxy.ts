import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Next.js 16 renamed the middleware.ts file convention to proxy.ts (the
 * underlying request-interception mechanism is unchanged — see
 * https://nextjs.org/docs/messages/middleware-to-proxy). This file was
 * middleware.ts through Phase 0-3 development; renamed here once a real
 * `next build` surfaced the deprecation warning.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Run on every route except static assets and the PWA manifest/service
     * worker, which must be served without a cookie round-trip.
     */
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icons/).*)",
  ],
};
