"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export interface SupportRequestFormState {
  error?: string;
  success?: boolean;
}

const MAX_MESSAGE_LENGTH = 2000;

export async function submitSupportRequest(
  _prevState: SupportRequestFormState,
  formData: FormData
): Promise<SupportRequestFormState> {
  const message = String(formData.get("message") ?? "").trim();

  if (message.length === 0) {
    return { error: "Please enter a message before sending." };
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { error: `That message is a bit long — please keep it under ${MAX_MESSAGE_LENGTH} characters.` };
  }

  const supabase = await createServerSupabaseClient();

  // business_id/submitted_by/status are all forced server-side by the
  // set_sender trigger (migration 0057) regardless of what's sent here —
  // this insert only ever needs to supply the message itself.
  const { error } = await supabase.from("support_requests").insert({ message });

  if (error) {
    console.error("submitSupportRequest: insert failed", error);
    return { error: "Couldn't send your message. Please try again." };
  }

  revalidatePath("/dashboard");
  return { success: true };
}