/**
 * Mirrors the row shape returned by notification_feed()
 * (supabase/migrations/0034_notifications.sql). `data` is intentionally
 * loose (Record<string, unknown>) at this level — format.ts narrows it
 * per `type` — because the database returns raw facts, not a
 * pre-formatted sentence (Section: Money; currency is per-business, so
 * baking "GHS" into a stored string would be wrong for the first
 * non-Ghanaian shop). See 0034's header for the full reasoning.
 */
export type NotificationType = "low_stock" | "credit_limit" | "stuck_payment" | "refund_created" | "sale_voided";

export type NotificationSeverity = "info" | "warning" | "critical";

export interface NotificationFeedRow {
  dismissal_key: string;
  type: NotificationType;
  severity: NotificationSeverity;
  reference_type: string;
  reference_id: string;
  branch_id: string | null;
  occurred_at: string;
  data: Record<string, unknown>;
  is_read: boolean;
}

export interface LowStockData {
  product_name: string;
  sku: string;
  branch_name: string;
  quantity: number;
  reorder_point: number;
  stock_severity: "out" | "critical" | "low";
}

export interface CreditLimitData {
  customer_name: string;
  balance: number;
  credit_limit: number;
}

export interface StuckPaymentData {
  receipt_number: string;
  created_at: string;
}

export interface RefundCreatedData {
  receipt_number: string;
  refund_number: string;
  total: number;
  reason: string | null;
  cashier_id: string | null;
}

export interface SaleVoidedData {
  receipt_number: string;
  total: number;
  reason: string | null;
  cashier_id: string | null;
}