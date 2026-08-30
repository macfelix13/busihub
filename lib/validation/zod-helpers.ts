import type { ZodError } from "zod";

/** Flattens a ZodError into the { fieldName: message } shape every form-state action in this app returns (first issue per field wins). */
export function zodFieldErrors(error: ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}
