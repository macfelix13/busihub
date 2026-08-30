/**
 * Shared type for the `setAll` cookie callback @supabase/ssr expects.
 * `options` is deliberately `any`: it's passed straight through to Next's
 * own `cookies().set()` / `NextResponse.cookies.set()`, whose exact
 * options type has moved around across Next versions — typing it `any`
 * here avoids this file breaking again on the next Next.js/@supabase/ssr
 * version bump, at the (small, server-only, non-user-facing) cost of
 * losing type-checking on cookie option names like `httpOnly`/`maxAge`.
 */
export type CookieToSet = {
  name: string;
  value: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: any;
};
