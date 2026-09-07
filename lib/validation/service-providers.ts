import { z } from "zod";

/**
 * Shared client+server validation for the service-provider create/edit
 * forms (migration 0045) — same rationale as every other schema in this
 * folder: the Server Action re-validates this, the client is never
 * trusted on its own.
 *
 * Deliberately NOT reusing customerSchema/CATEGORY-style patterns
 * wholesale: a service provider has no email and no credit limit, and
 * its branch is a required field (it is tied to exactly one branch —
 * see migration 0045's file header), unlike a customer's optional
 * preferred branch.
 */

const optionalTrimmed = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

export const serviceProviderSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  // Free text — "Barber", "Nail technician", "Braider" — not a controlled
  // vocabulary, same treatment as products.description.
  title: optionalTrimmed(100),
  phone: optionalTrimmed(40),
  branchId: z.string().uuid("Choose a branch"),
});

export type ServiceProviderInput = z.infer<typeof serviceProviderSchema>;

export const serviceProviderStatusSchema = z.enum(["active", "archived"]);

/**
 * What the upload widget is allowed to send, checked again on the server
 * before anything touches storage — the bucket's own file_size_limit and
 * allowed_mime_types (migration 0045) are a second, independent backstop,
 * not a substitute for this.
 */
export const ALLOWED_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB, matches the bucket's file_size_limit

export function isAllowedPhotoFile(file: { type: string; size: number }): boolean {
  return (
    (ALLOWED_PHOTO_MIME_TYPES as readonly string[]).includes(file.type) &&
    file.size > 0 &&
    file.size <= MAX_PHOTO_BYTES
  );
}