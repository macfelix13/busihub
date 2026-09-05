import { formatMoney, toMinorUnits } from "@/lib/money/money";
import type {
  CreditLimitData,
  LowStockData,
  NotificationFeedRow,
  RefundCreatedData,
  SaleVoidedData,
  StuckPaymentData,
} from "./types";

export interface FormattedNotification {
  title: string;
  body: string;
  href: string;
}

/**
 * Composes the sentence a person actually reads, client-side, from the
 * raw facts the database returned. Kept out of SQL for the same reason
 * receipt formatting (lib/receipts/format.ts) is a pure function rather
 * than inline in a component: this is arithmetic-adjacent (currency
 * formatting) and one place to test, not a string baked into a stored
 * row that would hardcode this business's currency into the database
 * forever.
 */
export function formatNotification(n: NotificationFeedRow, currencyCode: string): FormattedNotification {
  const money = (amount: number | string | undefined) => formatMoney(toMinorUnits(amount ?? 0), currencyCode);

  switch (n.type) {
    case "low_stock": {
      const d = n.data as unknown as LowStockData;
      const title =
        d.stock_severity === "out"
          ? `${d.product_name} is out of stock`
          : d.stock_severity === "critical"
            ? `${d.product_name} is critically low`
            : `${d.product_name} is low on stock`;
      return {
        title,
        body: `${d.branch_name} — ${d.quantity} left (reorder point ${d.reorder_point}).`,
        href: `/inventory/${n.reference_id}`,
      };
    }
    case "credit_limit": {
      const d = n.data as unknown as CreditLimitData;
      return {
        title: `${d.customer_name} has reached their credit limit`,
        body: `Owes ${money(d.balance)} of a ${money(d.credit_limit)} limit.`,
        href: `/customers/${n.reference_id}`,
      };
    }
    case "stuck_payment": {
      const d = n.data as unknown as StuckPaymentData;
      return {
        title: `Sale ${d.receipt_number} is still waiting for payment`,
        body: "The mobile money prompt was never confirmed.",
        href: `/sales/${n.reference_id}`,
      };
    }
    case "refund_created": {
      const d = n.data as unknown as RefundCreatedData;
      return {
        title: `Refund ${d.refund_number} recorded on ${d.receipt_number}`,
        body: `${money(d.total)} returned${d.reason ? ` — ${d.reason}` : ""}.`,
        href: `/sales/${n.reference_id}`,
      };
    }
    case "sale_voided": {
      const d = n.data as unknown as SaleVoidedData;
      return {
        title: `Sale ${d.receipt_number} was voided`,
        body: `${money(d.total)}${d.reason ? ` — ${d.reason}` : ""}.`,
        href: `/sales/${n.reference_id}`,
      };
    }
    default:
      // Exhaustiveness would need `never` here if NotificationType grows
      // without a matching case — deliberately falls back rather than
      // throwing, since a bell that crashes on an unrecognized type is
      // worse than one that shows a generic line.
      return { title: "Notification", body: "", href: "/dashboard" };
  }
}