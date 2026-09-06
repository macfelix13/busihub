import { z } from "zod";

/**
 * Shared client+server validation (Section 29) for the staff-invite form.
 * branchId/roleId are re-verified server-side against this business's own
 * rows regardless of what passes this schema (lib/validation never trusts
 * a client on its own, and a <select>'s options being "real" doesn't mean
 * a request actually came from that rendered form).
 */
export const inviteStaffSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(60),
  lastName: z.string().trim().max(60).optional().default(""),
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  branchId: z.string().uuid("Choose a branch"),
  roleId: z.string().uuid("Choose a role"),
});

export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;