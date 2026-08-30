import { z } from "zod";

/**
 * Shared client+server validation for branch create/edit forms (Phase 4).
 * Same rationale as lib/validation/auth.ts: the Server Action re-validates
 * this, the client never being trusted on its own.
 */
const optionalTrimmed = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal(""));

export const branchSchema = z.object({
  name: z.string().trim().min(1, "Branch name is required").max(120),
  addressLine1: optionalTrimmed(200),
  addressLine2: optionalTrimmed(200),
  city: optionalTrimmed(100),
  region: optionalTrimmed(100),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s-]{7,20}$/, "Enter a valid phone number")
    .optional()
    .or(z.literal("")),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address")
    .optional()
    .or(z.literal("")),
  timezone: z.string().trim().min(1, "Timezone is required").max(64),
  status: z.enum(["active", "inactive"]),
});

export type BranchInput = z.infer<typeof branchSchema>;

/** IANA timezones actually relevant to a Ghana-first POS — kept short and curated rather than the full ~400-entry IANA list, which would be a poor <select> experience for this audience. Extend as the business expands beyond Ghana. */
export const SUPPORTED_TIMEZONES = [
  "Africa/Accra",
  "Africa/Lagos",
  "Africa/Abidjan",
  "Africa/Nairobi",
  "Africa/Johannesburg",
  "Europe/London",
  "UTC",
] as const;

