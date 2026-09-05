"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import type { NotificationFeedRow } from "./types";

export interface NotificationFeedResult {
  notifications: NotificationFeedRow[];
  currencyCode: string;
  error?: string;
}

/**
 * Everything the bell needs in one round trip: the feed itself (already
 * unread-first, newest-first, capped at 50 — see notification_feed()'s
 * own comment) plus the business's currency for formatting money client-
 * side. RLS on notifications/stock_levels/customer_balances/sales is the
 * real gate here, same as every other read in this app; this action adds
 * no permission check of its own because there is nothing to check
 * beyond "is this a signed-in member of a business", same reasoning as
 * "My PIN" needing no permission gate.
 */
export async function getNotificationFeed(): Promise<NotificationFeedResult> {
  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await getCurrentBusinessId(supabase);
  } catch (err) {
    console.error("getNotificationFeed: business lookup failed", err);
    return { notifications: [], currencyCode: "GHS", error: "Something went wrong." };
  }

  const [{ data, error }, { data: business }] = await Promise.all([
    supabase.rpc("notification_feed", { p_branch_id: null, p_limit: 50 }),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
  ]);

  if (error) {
    console.error("getNotificationFeed: rpc failed", error);
    return { notifications: [], currencyCode: business?.currency_code ?? "GHS", error: "Couldn't load notifications." };
  }

  return {
    notifications: (data ?? []) as NotificationFeedRow[],
    currencyCode: business?.currency_code ?? "GHS",
  };
}

/** Marks one notification (event or computed state) read, for the caller only. */
export async function markNotificationRead(dismissalKey: string): Promise<{ error?: string }> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("mark_notification_read", { p_dismissal_key: dismissalKey });
  if (error) {
    console.error("markNotificationRead: rpc failed", error);
    return { error: "Couldn't update that notification." };
  }
  return {};
}

/** Marks everything the caller can currently see as read. */
export async function markAllNotificationsRead(): Promise<{ error?: string }> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("mark_all_notifications_read");
  if (error) {
    console.error("markAllNotificationsRead: rpc failed", error);
    return { error: "Couldn't update your notifications." };
  }
  return {};
}