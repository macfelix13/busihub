import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PermissionKey } from "./permissions";

/**
 * Thrown by requirePermission()/requireBranchPermission(). Route
 * Handlers/Server Actions should catch this at their boundary and return
 * a generic 403 — never let the raw message leak internal details, and
 * never let it silently pass through as a 500 (Section 38).
 */
export class AuthorizationError extends Error {
  constructor(message = "You don't have permission to perform this action.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Server-side permission gate. This is the REAL authorization check
 * (Section 7, Section 49) — UI-level hiding of buttons is a courtesy, not
 * a security boundary. Every Server Action / Route Handler that mutates
 * or reads sensitive tenant data must call this (or
 * requireBranchPermission) before doing anything, even though RLS would
 * also block an unauthorized write — defense in depth, and it lets us
 * return a clean error instead of a raw Postgres RLS failure.
 *
 * Delegates to the app_has_permission() Postgres function (see
 * supabase/migrations/0008_auth_helper_functions.sql) so the permission
 * logic is defined once, not duplicated between the app and the database.
 */
export async function requirePermission(
  supabase: SupabaseClient,
  businessId: string,
  permission: PermissionKey
): Promise<void> {
  const { data, error } = await supabase.rpc("app_has_permission", {
    p_business_id: businessId,
    p_permission_key: permission,
  });

  if (error) {
    // Fail closed: a broken permission check is treated as "not
    // authorized", never as "authorized by default".
    throw new AuthorizationError();
  }

  if (!data) {
    throw new AuthorizationError();
  }
}

export async function requireBranchPermission(
  supabase: SupabaseClient,
  branchId: string,
  permission: PermissionKey
): Promise<void> {
  const { data, error } = await supabase.rpc("app_has_branch_permission", {
    p_branch_id: branchId,
    p_permission_key: permission,
  });

  if (error || !data) {
    throw new AuthorizationError();
  }
}

/**
 * Convenience check that returns a boolean instead of throwing — for UI
 * decisions (show/hide a button) where the caller doesn't want a thrown
 * error, remembering that this is still not the security boundary; the
 * corresponding requirePermission() call still has to happen server-side
 * wherever the actual mutation occurs.
 */
export async function hasPermission(
  supabase: SupabaseClient,
  businessId: string,
  permission: PermissionKey
): Promise<boolean> {
  const { data, error } = await supabase.rpc("app_has_permission", {
    p_business_id: businessId,
    p_permission_key: permission,
  });
  return !error && Boolean(data);
}
