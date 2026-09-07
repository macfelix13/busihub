"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { serviceProviderSchema, isAllowedPhotoFile } from "@/lib/validation/service-providers";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";
import { serviceProviderPhotoPath, SERVICE_PROVIDER_PHOTOS_BUCKET } from "@/lib/storage/service-provider-photos";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

type SupabaseServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

async function requireServiceProviderPermission(supabase: SupabaseServerClient) {
  const businessId = await getCurrentBusinessId(supabase);
  // Creating, editing, and archiving is a staffing decision — gated by
  // users.manage, same permission that already gates inviting/editing a
  // real staff member (0036). See migration 0045's file header for why
  // this doesn't reuse products.* the way categories did.
  await requirePermission(supabase, businessId, PERMISSIONS.USERS_MANAGE);
  return businessId;
}

function providerFormValues(formData: FormData) {
  return {
    name: formData.get("name"),
    title: formData.get("title"),
    phone: formData.get("phone"),
    branchId: formData.get("branchId"),
  };
}

/**
 * Uploads a photo already attached to the create/edit form, best-effort —
 * a failed image upload should never sink an otherwise-valid create or
 * update of the provider record itself. Returns the new path on success,
 * or null (having already logged) on any failure, including "no file was
 * actually chosen" (the input is always present in the form, empty or
 * not).
 */
async function tryUploadPhoto(
  supabase: SupabaseServerClient,
  businessId: string,
  providerId: string,
  formData: FormData
): Promise<string | null> {
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return null;

  if (!isAllowedPhotoFile(file)) {
    console.error("tryUploadPhoto: rejected file", { type: file.type, size: file.size });
    return null;
  }

  const path = serviceProviderPhotoPath(businessId, providerId, file.name);

  const { error } = await supabase.storage.from(SERVICE_PROVIDER_PHOTOS_BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false,
  });

  if (error) {
    console.error("tryUploadPhoto: upload failed", error);
    return null;
  }

  return path;
}

async function deletePhotoObject(supabase: SupabaseServerClient, path: string | null | undefined) {
  if (!path) return;
  const { error } = await supabase.storage.from(SERVICE_PROVIDER_PHOTOS_BUCKET).remove([path]);
  if (error) {
    // Not fatal — an orphaned object in a private bucket costs nothing a
    // tenant can see or be charged meaningfully for, and is not worth
    // failing the surrounding request over.
    console.error("deletePhotoObject: remove failed", { path, error });
  }
}

export async function createServiceProvider(_prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = serviceProviderSchema.safeParse(providerFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireServiceProviderPermission(supabase);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("createServiceProvider: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { name, title, phone, branchId } = parsed.data;

  // business_id is NOT sent — set_service_provider_context() (migration
  // 0045) derives it from branchId on insert and refuses an unknown
  // branch outright, so there is nothing here for a tampered request to
  // override.
  const { data: created, error } = await supabase
    .from("service_providers")
    .insert({
      branch_id: branchId,
      name,
      title: title || null,
      phone: phone || null,
    })
    .select("id")
    .single();

  if (error || !created) {
    console.error("createServiceProvider: insert failed", error);
    if (error?.code === "P0002") {
      return { error: "That branch could not be found.", fieldErrors: { branchId: "Invalid branch." } };
    }
    return { error: "Couldn't create this service provider. Please try again." };
  }

  // Best-effort: the record exists either way; a photo can always be
  // added afterward from the edit page.
  const photoPath = await tryUploadPhoto(supabase, businessId, created.id, formData);
  if (photoPath) {
    const { error: photoError } = await supabase
      .from("service_providers")
      .update({ photo_url: photoPath })
      .eq("id", created.id)
      .eq("business_id", businessId);
    if (photoError) {
      console.error("createServiceProvider: saving photo_url failed", photoError);
    }
  }

  revalidatePath("/settings/service-providers");
  revalidatePath("/till");
  redirect("/settings/service-providers");
}

export async function updateServiceProvider(
  providerId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  const parsed = serviceProviderSchema.safeParse(providerFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireServiceProviderPermission(supabase);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("updateServiceProvider: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { name, title, phone, branchId } = parsed.data;

  const { error } = await supabase
    .from("service_providers")
    .update({ branch_id: branchId, name, title: title || null, phone: phone || null })
    // business_id filter is belt-and-suspenders beyond RLS (Section 49) —
    // a wrong/forged providerId for another tenant affects 0 rows.
    .eq("id", providerId)
    .eq("business_id", businessId);

  if (error) {
    console.error("updateServiceProvider: update failed", error);
    if (error.code === "P0002") {
      return { error: "That branch could not be found.", fieldErrors: { branchId: "Invalid branch." } };
    }
    return { error: "Couldn't save changes. Please try again." };
  }

  const photoPath = await tryUploadPhoto(supabase, businessId, providerId, formData);
  if (photoPath) {
    // Read back the OLD path first — the update below overwrites the
    // column, and the old file (if any) is only safe to delete once the
    // new one is confirmed in place.
    const { data: existing } = await supabase
      .from("service_providers")
      .select("photo_url")
      .eq("id", providerId)
      .eq("business_id", businessId)
      .maybeSingle();

    const { error: photoError } = await supabase
      .from("service_providers")
      .update({ photo_url: photoPath })
      .eq("id", providerId)
      .eq("business_id", businessId);

    if (photoError) {
      console.error("updateServiceProvider: saving photo_url failed", photoError);
    } else {
      await deletePhotoObject(supabase, existing?.photo_url);
    }
  }

  revalidatePath("/settings/service-providers");
  revalidatePath("/till");
  redirect("/settings/service-providers");
}

/**
 * Plain (no useFormState) action bound to a provider id and target
 * status, same pattern as products/categories/actions.ts's
 * setCategoryStatus — the triggering button is only ever rendered for a
 * caller who already has users.manage (cosmetic check), so a thrown
 * error here means permissions changed out from under them mid-session.
 */
export async function setServiceProviderStatus(providerId: string, status: "active" | "archived"): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const businessId = await requireServiceProviderPermission(supabase);

  const { error } = await supabase
    .from("service_providers")
    .update({ status })
    .eq("id", providerId)
    .eq("business_id", businessId);

  if (error) {
    console.error("setServiceProviderStatus: update failed", error);
    throw new Error("Couldn't update this service provider's status. Please try again.");
  }

  revalidatePath("/settings/service-providers");
  revalidatePath("/till");
}

/**
 * Removes a provider's photo without touching anything else about the
 * record. Plain action (no form state) — the edit page calls this
 * directly and re-renders with photo_url now null.
 */
export async function removeServiceProviderPhoto(providerId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const businessId = await requireServiceProviderPermission(supabase);

  const { data: existing, error: readError } = await supabase
    .from("service_providers")
    .select("photo_url")
    .eq("id", providerId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (readError || !existing?.photo_url) {
    if (readError) console.error("removeServiceProviderPhoto: read failed", readError);
    return;
  }

  const { error: updateError } = await supabase
    .from("service_providers")
    .update({ photo_url: null })
    .eq("id", providerId)
    .eq("business_id", businessId);

  if (updateError) {
    console.error("removeServiceProviderPhoto: clearing photo_url failed", updateError);
    throw new Error("Couldn't remove the photo. Please try again.");
  }

  await deletePhotoObject(supabase, existing.photo_url);

  revalidatePath("/settings/service-providers");
  revalidatePath("/till");
}