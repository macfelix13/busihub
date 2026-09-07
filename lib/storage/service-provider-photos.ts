import type { createServerSupabaseClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

/**
 * Shared helpers for the private service-provider-photos bucket
 * (migration 0045). Kept in one place so the bucket name, the path
 * shape, and the signed-url lifetime can never drift between the upload
 * action and whatever renders the photo back.
 *
 * The bucket is PRIVATE — see that migration's file header for why a
 * public bucket (readable by anyone holding the URL, forever, with no
 * permission check) was rejected. photo_url on service_providers stores
 * only the OBJECT PATH; every render resolves it to a short-lived signed
 * URL via signServiceProviderPhotoUrl(), scoped by the same RLS the
 * bucket's own storage.objects policies enforce (a caller who could not
 * see this row's business could not sign a URL for its photo either).
 */

export const SERVICE_PROVIDER_PHOTOS_BUCKET = "service-provider-photos";

/** How long a signed URL stays good for. Short enough that a leaked link
 *  (a browser cache, a shared screenshot) is stale soon, long enough that
 *  a single page render never fails a photo mid-scroll. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * Where a provider's photo lives inside the bucket:
 * "<business_id>/<provider_id>/<timestamp>-<safe filename>". The leading
 * business_id segment is what every storage.objects RLS policy on this
 * bucket scopes against (storage.foldername(name)[1]) — it must always be
 * the CALLER's own business_id, never taken from the client, exactly like
 * every other business_id in this schema.
 */
export function serviceProviderPhotoPath(businessId: string, providerId: string, filename: string): string {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "photo";
  return `${businessId}/${providerId}/${Date.now()}-${safeName}`;
}

/**
 * Resolves a stored path to a temporary, directly-loadable URL. Returns
 * null (rather than throwing) on failure — a page missing one photo
 * should still render, not blow up the whole request.
 */
export async function signServiceProviderPhotoUrl(
  supabase: SupabaseServerClient,
  path: string | null | undefined
): Promise<string | null> {
  if (!path) return null;

  const { data, error } = await supabase.storage
    .from(SERVICE_PROVIDER_PHOTOS_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    console.error("signServiceProviderPhotoUrl: could not sign", { path, error });
    return null;
  }

  return data.signedUrl;
}

/**
 * Signs a whole batch at once (a list page has many rows) without one
 * failed lookup taking the others down with it.
 */
export async function signServiceProviderPhotoUrls(
  supabase: SupabaseServerClient,
  paths: (string | null | undefined)[]
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(paths.filter((p): p is string => Boolean(p))));
  const result = new Map<string, string>();

  await Promise.all(
    unique.map(async (path) => {
      const url = await signServiceProviderPhotoUrl(supabase, path);
      if (url) result.set(path, url);
    })
  );

  return result;
}