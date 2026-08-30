import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";
import { supabaseAnonKey, supabaseServiceRoleKey, supabaseUrl } from "./env";
import type { CookieToSet } from "./cookie-types";

/**
 * RLS-scoped server client bound to the current request's session cookie.
 * Use this in Server Components, Route Handlers, and Server Actions for
 * any read/write that should respect the signed-in user's permissions —
 * i.e. almost everything.
 */
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component that can't set cookies (e.g. a
          // route rendered statically). Session refresh is still handled
          // by proxy.ts on every request, so this is safe to ignore.
        }
      },
    },
  });
}

/**
 * SERVICE-ROLE client. Bypasses Row Level Security entirely.
 *
 * SERVER ONLY — never import from a file that a Client Component could
 * pull in. Restricted to:
 *   - Paystack webhook handling (no user session exists yet)
 *   - Super Admin privileged reads (explicitly audited, Section 31)
 *   - Trusted background/Edge Function jobs
 *
 * Every call site using this client MUST perform its own explicit
 * authorization check before touching tenant data, since the database
 * will no longer do it for you.
 */
export function createServiceRoleClient() {
  return createServerClient<Database>(supabaseUrl(), supabaseServiceRoleKey(), {
    cookies: {
      getAll() {
        return [];
      },
      setAll() {
        // Service-role client is never tied to a browser session.
      },
    },
  });
}
