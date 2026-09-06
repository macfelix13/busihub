import { z } from "zod";
import { CATEGORY_ICON_VALUES } from "@/lib/ui/category-icons";

/**
 * Shared client+server validation for the category create/edit forms —
 * same rationale as lib/validation/products.ts: the Server Action
 * re-validates this, the client is never trusted on its own.
 */

const optionalTrimmed = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

export const categorySchema = z.object({
  name: z.string().trim().min(1, "Category name is required").max(100),
  description: optionalTrimmed(500),
  // Blank means "no icon" — a category doesn't need one to be usable.
  // Anything non-blank must be a name from the curated allowlist; a
  // client sending an unrecognized string (tampered request, or a stale
  // form from before an icon was retired) is refused rather than stored
  // verbatim, since this value is never rendered as markup but is still
  // not something to trust blindly.
  icon: z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || (CATEGORY_ICON_VALUES as readonly string[]).includes(v), {
      message: "Choose one of the available icons",
    }),
});

export type CategoryInput = z.infer<typeof categorySchema>;

export const categoryStatusSchema = z.enum(["active", "archived"]);