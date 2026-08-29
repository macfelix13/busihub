/** Non-Supabase app-level environment variables. */
export function supabaseAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}
