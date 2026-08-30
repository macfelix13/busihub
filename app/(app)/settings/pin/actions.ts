"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertValidPinFormat, InvalidPinFormatError } from "@/lib/auth/pin";

export interface PinFormState {
  error?: string;
  success?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Sets the signed-in user's own till PIN.
 *
 * The PIN is sent to set_profile_pin() and hashed inside the database
 * (migration 0018) rather than here: the hash is not readable by any
 * client, so it can never be verified client-side, and keeping both
 * halves in pgcrypto removes any question of two bcrypt implementations
 * agreeing. lib/auth/pin.ts is still the source of the format rule, which
 * is checked here for a fast, friendly error and again in the database
 * because that function is reachable directly.
 */
export async function setOwnPin(_prevState: PinFormState, formData: FormData): Promise<PinFormState> {
  const pin = String(formData.get("pin") ?? "");
  const confirmPin = String(formData.get("confirmPin") ?? "");

  try {
    assertValidPinFormat(pin);
  } catch (err) {
    if (err instanceof InvalidPinFormatError) {
      return { error: err.message, fieldErrors: { pin: err.message } };
    }
    throw err;
  }

  if (pin !== confirmPin) {
    return { error: "The two PINs don't match.", fieldErrors: { confirmPin: "This doesn't match." } };
  }

  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You're not signed in." };
  }

  const { error } = await supabase.rpc("set_profile_pin", { p_profile_id: user.id, p_pin: pin });

  if (error) {
    console.error("setOwnPin: rpc failed", error);
    if (error.code === "22023") {
      return { error: "A PIN must be 4 to 6 digits.", fieldErrors: { pin: "Must be 4 to 6 digits." } };
    }
    return { error: "Couldn't set your PIN. Please try again." };
  }

  revalidatePath("/settings/pin");
  return { success: "Your PIN has been set." };
}
