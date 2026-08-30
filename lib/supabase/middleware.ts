import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseAnonKey, supabaseUrl } from "./env";
import type { CookieToSet } from "./cookie-types";

/**
 * Refreshes the Supabase session cookie on every request. Supabase Auth
 * SSR sessions expire; without this, a user's session silently stops
 * refreshing and they get logged out at an unpredictable time. This must
 * run before any Server Component reads the session.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // IMPORTANT: do not remove. This call refreshes the auth token and must
  // run on every request that touches a protected route.
  await supabase.auth.getUser();

  return response;
}
