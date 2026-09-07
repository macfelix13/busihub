import type { createServerSupabaseClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

/**
 * Shared helpers for the private product-photos bucket (migration 0046).
 * Kept in one place so the bucket name, the path shape, and the signed-url
 * lifetime can never drift between an upload action and whatever renders
 * the photo back — same rationale as lib/storage/service-provider-photos.ts.
 *
 * One real difference from that file: a product's photo can render on the
 * till grid, which may show anywhere from a handful to a few hundred
 * products at once, reloaded many times a day, often on shop wifi or
 * mobile data. signProductPhotoUrls() below signs a whole page of paths in
 * ONE Storage API call (createSignedUrls) rather than one round trip per
 * photo — an N+1 signing pattern that was fine for a small, admin-only
 * service-provider list would be a real, avoidable cost here.
 */

export const PRODUCT_PHOTOS_BUCKET = "product-photos";

/** Same lifetime as service-provider photos — short enough that a leaked
 *  link goes stale soon, long enough that one page render never fails a
 *  photo mid-scroll. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * Where a product's photo lives inside the bucket:
 * "<business_id>/<product_id or a throwaway token>/<timestamp>-<safe filename>".
 * Only the leading business_id segment is ever checked by RLS
 * (storage.foldername(name)[1] — see migration 0046) — it must always be
 * the CALLER's own business_id, never taken from the client. The second
 * segment is purely organizational: normally the product's real id, but
 * for a brand-new product being created for the first time it is instead
 * a random token (crypto.randomUUID() in the caller), since the photo is
 * uploaded before the product has an id yet.
 */
export function productPhotoPath(businessId: string, productIdOrToken: string, filename: string): string {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "photo";
  return `${businessId}/${productIdOrToken}/${Date.now()}-${safeName}`;
}

/**
 * Resolves a stored path to a temporary, directly-loadable URL. Returns
 * null (rather than throwing) on failure — a page missing one photo
 * should still render, not blow up the whole request.
 */
export async function signProductPhotoUrl(
  supabase: SupabaseServerClient,
  path: string | null | undefined
): Promise<string | null> {
  if (!path) return null;

  const { data, error } = await supabase.storage.from(PRODUCT_PHOTOS_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    console.error("signProductPhotoUrl: could not sign", { path, error });
    return null;
  }

  return data.signedUrl;
}

/**
 * Signs many paths in ONE request via Storage's own batch endpoint. Used
 * by the Products list and the till, both of which can render many rows
 * at once — see this file's header for why that matters here specifically.
 * A path this caller's RLS can't actually read (should never happen for
 * their own business's products, but never trusted blindly) simply comes
 * back without an entry in the map, same as any other failed sign.
 */
export async function signProductPhotoUrls(
  supabase: SupabaseServerClient,
  paths: (string | null | undefined)[]
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(paths.filter((p): p is string => Boolean(p))));
  const result = new Map<string, string>();
  if (unique.length === 0) return result;

  const { data, error } = await supabase.storage.from(PRODUCT_PHOTOS_BUCKET).createSignedUrls(unique, SIGNED_URL_TTL_SECONDS);

  if (error) {
    console.error("signProductPhotoUrls: batch sign failed", error);
    return result;
  }

  for (const row of data ?? []) {
    const signedUrl = (row as { signedUrl?: string | null }).signedUrl;
    const path = (row as { path?: string | null }).path;
    const rowError = (row as { error?: string | null }).error;
    if (signedUrl && !rowError && path) {
      result.set(path, signedUrl);
    }
  }

  return result;
}