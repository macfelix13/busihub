import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { BusinessOnboardingForm } from "./business-onboarding-form";

export const metadata = { title: "Set up your business — Busihub" };

/**
 * Reached only from app/auth/confirm/route.ts, right after a brand-new
 * Google/Apple sign-in — see that route's and
 * lib/auth/finish-pending-registration.ts's own comments for the full
 * why. Requires an authenticated session (the OAuth sign-in that landed
 * here) but deliberately does NOT require a profile — that's the one
 * thing this page exists to create.
 */
export default async function BusinessOnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const nextPath = next && next.startsWith("/") ? next : "/dashboard";

  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Not a fresh sign-in after all (e.g. this page was bookmarked, or
  // visited a second time in another tab after already finishing) —
  // nothing left to do here.
  const { data: existingProfile } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (existingProfile) {
    redirect(nextPath);
  }

  // Best-effort prefill from whatever the provider sent — Google
  // typically includes `full_name`/`name`, sometimes `given_name`/
  // `family_name` too. Never required to be right: every field below is
  // still editable, this just saves re-typing a name Google already
  // knows. Anything unrecognized (an empty/missing field on some other
  // provider later, or Apple's own metadata shape once that's added)
  // just leaves the fields blank rather than guessing.
  const meta = user.user_metadata as Record<string, unknown>;
  const givenName = typeof meta.given_name === "string" ? meta.given_name : "";
  const familyName = typeof meta.family_name === "string" ? meta.family_name : "";
  let defaultFirstName = givenName;
  let defaultLastName = familyName;
  if (!defaultFirstName && !defaultLastName) {
    const fullName = typeof meta.full_name === "string" ? meta.full_name : typeof meta.name === "string" ? meta.name : "";
    const [first = "", ...rest] = fullName.trim().split(/\s+/).filter(Boolean);
    defaultFirstName = first;
    defaultLastName = rest.join(" ");
  }

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">One more step</h1>
      <p className="mb-6 text-sm text-neutral-500 dark:text-ink-muted">
        Tell us about your business to finish setting up your account.
      </p>

      <BusinessOnboardingForm next={nextPath} defaultFirstName={defaultFirstName} defaultLastName={defaultLastName} />
    </>
  );
}