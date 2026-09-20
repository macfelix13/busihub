import { z } from "zod";

/**
 * Shared client+server validation (Section 29). The client uses these for
 * fast feedback; the Server Action re-validates the same schema before
 * touching Supabase, since the client's validation is never trusted on
 * its own.
 */

export const registerSchema = z.object({
  businessName: z.string().trim().min(2, "Business name must be at least 2 characters").max(120),
  ownerFirstName: z.string().trim().min(1, "First name is required").max(60),
  ownerLastName: z.string().trim().max(60).optional().default(""),
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s-]{7,20}$/, "Enter a valid phone number")
    .optional()
    .or(z.literal("")),
  password: z
    .string()
    .min(10, "Password must be at least 10 characters")
    .regex(/[a-z]/, "Password must include a lowercase letter")
    .regex(/[A-Z]/, "Password must include an uppercase letter")
    .regex(/[0-9]/, "Password must include a number"),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Google/Apple sign-in (2026-09) never collects a business name upfront
 * the way registerSchema's form does — the provider only ever hands back
 * a name, email, and maybe a photo. This is the same business-side fields
 * from registerSchema, reused for the "what's your business called?" step
 * shown once, right after a brand-new OAuth sign-in, before landing
 * anywhere else — see app/(auth)/onboarding/business/actions.ts and
 * app/auth/confirm/route.ts for where this fits in the flow.
 */
export const completeBusinessSchema = z.object({
  businessName: z.string().trim().min(2, "Business name must be at least 2 characters").max(120),
  ownerFirstName: z.string().trim().min(1, "First name is required").max(60),
  ownerLastName: z.string().trim().max(60).optional().default(""),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s-]{7,20}$/, "Enter a valid phone number")
    .optional()
    .or(z.literal("")),
});

export type CompleteBusinessInput = z.infer<typeof completeBusinessSchema>;