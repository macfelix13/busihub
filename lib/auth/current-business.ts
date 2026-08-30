import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Thrown when the caller has no session, or a session with no linked business (shouldn't happen past the (app) layout guard, but every Server Action here checks independently â€” never assumes a caller reached it "the normal way"). */
export class NoBusinessError extends Error {
  constructor() {
    super("This account is not linked to a business.");
    this.name = "NoBusinessError";
  }
}

/** Resolves the caller's own business_id via app_current_business_id() (supabase/migrations/0008) rather than a manual profiles query, so this stays in sync with the same function RLS policies use. */
export async function getCurrentBusinessId(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.rpc("app_current_business_id");

  if (error || !data) {
    throw new NoBusinessError();
  }

  return data as string;
}
