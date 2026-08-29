/**
 * Central place that reads and validates the Supabase-related environment
 * variables. Throws loudly at startup rather than letting `undefined` leak
 * into a client constructor and fail confusingly later.
 */
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required environment variable "${name}". Copy .env.example to .env.local and fill it in.`
    );
  }
  return value;
}

export const supabaseUrl = () =>
  required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);

export const supabaseAnonKey = () =>
  required(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

/**
 * SERVER ONLY. Never import this module from a Client Component — the
 * service role key bypasses Row Level Security entirely. It must only be
 * read inside Route Handlers, Server Actions, or other server-only code,
 * and only when the operation genuinely needs to bypass RLS (e.g. Super
 * Admin cross-tenant reads, webhook processing before a session exists).
 */
export const supabaseServiceRoleKey = () =>
  required("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY);
