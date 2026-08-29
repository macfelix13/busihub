import { signOut } from "@/lib/auth/sign-out";
import { SubmitButton } from "@/components/ui/button";

export function LogoutButton() {
  return (
    <form action={signOut}>
      <SubmitButton variant="ghost" pendingText="Signing out…">
        Sign out
      </SubmitButton>
    </form>
  );
}
