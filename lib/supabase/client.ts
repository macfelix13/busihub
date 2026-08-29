"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";
import { supabaseAnonKey, supabaseUrl } from "./env";

/**
 * Browser-side Supabase client. Holds only the public anon key — every
 * query it makes is subject to Row Level Security. This is the ONLY
 * Supabase client that should ever be constructed in a Client Component.
 */
export function createClient() {
  return createBrowserClient<Database>(supabaseUrl(), supabaseAnonKey());
}
