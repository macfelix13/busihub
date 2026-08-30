import { createServerSupabaseClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { PinForm } from "./pin-form";

export const metadata = { title: "Till PIN" };

export default async function PinSettingsPage() {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // pin_set_at is readable; pin_hash deliberately is not (migration 0018).
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, pin_set_at, pin_locked_until")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    console.error("PinSettingsPage: profile query failed", error);
  }

  const hasPin = Boolean(profile?.pin_set_at);
  const lockedUntil = profile?.pin_locked_until ? new Date(profile.pin_locked_until) : null;
  const isLocked = lockedUntil !== null && lockedUntil > new Date();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Till PIN</h1>
        <p className="text-neutral-500">
          A short code that identifies you at a shared till, so each sale records who made it.
        </p>
      </div>

      {isLocked ? (
        <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Your PIN is locked after too many wrong attempts until{" "}
          {lockedUntil.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}. Setting a new PIN below
          unlocks it.
        </p>
      ) : null}

      <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
        4 to 6 digits. It is stored hashed and can never be read back — not by us, not by your colleagues. Five wrong
        attempts locks it for 15 minutes.
        {hasPin ? " You already have a PIN set; entering a new one replaces it." : ""}
      </p>

      <PinForm hasPin={hasPin} />
    </div>
  );
}
