import "server-only";
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Thrown when the caller has no session, or a session with no linked business (shouldn't happen past the (app) layout guard, but every Server Action here checks independently — never assumes a caller reached it "the normal way"). */
export class NoBusinessError extends Error {
  constructor() {
    super("This account is not linked to a business.");
    this.name = "NoBusinessError";
  }
}

/**
 * Resolves the caller's own business_id via app_current_business_id()
 * (supabase/migrations/0008) rather than a manual profiles query, so this
 * stays in sync with the same function RLS policies use.
 *
 * Memoized per request with React's cache(). The (app) layout calls this
 * once to decide what to show in the header, and the page it wraps calls
 * it again to scope its own queries — without memoization that is the
 * same RPC run twice, back to back, on every single navigation. Because
 * createServerSupabaseClient() (lib/supabase/server.ts) is itself cached
 * per request, `supabase` here is the same object both callers hold, so
 * cache() actually gets a hit rather than treating them as unrelated
 * calls. A thrown NoBusinessError is not cached — cache() only memoizes
 * a function's return value, not a rejection, so a transient failure on
 * the first call doesn't wrongly poison every later call in the request.
 */
export const getCurrentBusinessId = cache(async function getCurrentBusinessId(
  supabase: SupabaseClient
): Promise<string> {
  const { data, error } = await supabase.rpc("app_current_business_id");

  if (error || !data) {
    throw new NoBusinessError();
  }

  return data as string;
});
