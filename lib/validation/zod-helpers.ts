import type { ZodError } from "zod";

/**
 * Flattens a ZodError into the { fieldName: message } shape every
 * form-state action in this app returns (first issue per field wins).
 * The key is the full dotted path (e.g. "variants.0.sku") so nested
 * array/object schemas (Phase 5's per-variant rows) can look up an error
 * for a specific row/field, not just a top-level one — for every schema
 * up to Phase 4 the path is always a single segment, so this is identical
 * to the old "path[0] only" behavior for all existing callers.
 */
export function zodFieldErrors(error: ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}

