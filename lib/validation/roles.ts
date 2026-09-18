import { z } from "zod";
import { PERMISSIONS } from "@/lib/rbac/permissions";

/**
 * Shared client+server validation for the roles management pages
 * (Settings → Staff → Roles) — same rationale as every other
 * lib/validation file: the Server Action re-validates this regardless of
 * what the client sent, and set_role_permissions() (0054) re-validates
 * permission keys against the real database catalog on top of this.
 */

const optionalTrimmed = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

export const roleDetailsSchema = z.object({
  name: z.string().trim().min(1, "Role name is required").max(60),
  description: optionalTrimmed(300),
});

export type RoleDetailsInput = z.infer<typeof roleDetailsSchema>;

// Object.values() on a `const` object of string literals is a string[] at
// the type level, but z.enum() needs a non-empty tuple type — the cast is
// safe because PERMISSIONS (lib/rbac/permissions.ts) is never empty.
const PERMISSION_KEYS = Object.values(PERMISSIONS) as [string, ...string[]];

/**
 * A permission checkbox grid posts zero or more `permission` values —
 * formData.getAll() gives an array of unknown strings, filtered down here
 * to only keys the platform catalog actually recognizes so a
 * tampered/stale value can't make it past this schema even before
 * set_role_permissions() checks it again in the database (the real
 * source of truth, per permissions.ts's own header comment).
 */
export const rolePermissionsSchema = z.object({
  permissionKeys: z.array(z.enum(PERMISSION_KEYS)).default([]),
});

export type RolePermissionsInput = z.infer<typeof rolePermissionsSchema>;