import { describe, expect, it } from "vitest";
import { formatNotification } from "@/lib/notifications/format";
import type { NotificationFeedRow } from "@/lib/notifications/types";

function row(overrides: Partial<NotificationFeedRow>): NotificationFeedRow {
  return {
    dismissal_key: "test:1",
    type: "low_stock",
    severity: "warning",
    reference_type: "product_variant",
    reference_id: "11111111-1111-1111-1111-111111111111",
    branch_id: "22222222-2222-2222-2222-222222222222",
    occurred_at: "2026-09-05T10:00:00Z",
    data: {},
    is_read: false,
    ...overrides,
  };
}

describe("formatNotification", () => {
  it("titles a low_stock alert by its stock_severity, not its notification severity", () => {
    const out = formatNotification(
      row({
        type: "low_stock",
        data: { product_name: "Rice 5kg", sku: "RICE-5", branch_name: "Main", quantity: 0, reorder_point: 5, stock_severity: "out" },
      }),
      "GHS"
    );
    expect(out.title).toBe("Rice 5kg is out of stock");
    expect(out.href).toBe("/inventory/11111111-1111-1111-1111-111111111111");

    const critical = formatNotification(
      row({ data: { product_name: "Salt", sku: "S", branch_name: "Main", quantity: 1, reorder_point: 10, stock_severity: "critical" } }),
      "GHS"
    );
    expect(critical.title).toBe("Salt is critically low");

    const low = formatNotification(
      row({ data: { product_name: "Sugar", sku: "S2", branch_name: "Main", quantity: 3, reorder_point: 5, stock_severity: "low" } }),
      "GHS"
    );
    expect(low.title).toBe("Sugar is low on stock");
    expect(low.body).toBe("Main — 3 left (reorder point 5).");
  });

  it("formats credit_limit money in the business's own currency, not a hardcoded one", () => {
    const out = formatNotification(
      row({
        type: "credit_limit",
        reference_type: "customer",
        data: { customer_name: "Ama Owusu", balance: 500, credit_limit: 500 },
      }),
      "GHS"
    );
    expect(out.title).toBe("Ama Owusu has reached their credit limit");
    expect(out.body).toContain("GH₵500.00");
    expect(out.href).toBe("/customers/11111111-1111-1111-1111-111111111111");

    const usd = formatNotification(
      row({ type: "credit_limit", data: { customer_name: "Ama Owusu", balance: 500, credit_limit: 500 } }),
      "USD"
    );
    expect(usd.body).toContain("$500.00");
  });

  it("links stuck_payment and event notifications to the sale", () => {
    const stuck = formatNotification(
      row({ type: "stuck_payment", reference_type: "sale", data: { receipt_number: "R-000042", created_at: "2026-09-05T09:40:00Z" } }),
      "GHS"
    );
    expect(stuck.title).toBe("Sale R-000042 is still waiting for payment");
    expect(stuck.href).toBe("/sales/11111111-1111-1111-1111-111111111111");
  });

  it("includes the reason when one was given, and omits it cleanly when not", () => {
    const withReason = formatNotification(
      row({
        type: "sale_voided",
        reference_type: "sale",
        data: { receipt_number: "R-000042", total: 45, reason: "Customer changed their mind" },
      }),
      "GHS"
    );
    expect(withReason.title).toBe("Sale R-000042 was voided");
    expect(withReason.body).toBe("GH₵45.00 — Customer changed their mind.");

    const noReason = formatNotification(
      row({ type: "sale_voided", data: { receipt_number: "R-000042", total: 45, reason: null } }),
      "GHS"
    );
    expect(noReason.body).toBe("GH₵45.00.");
  });

  it("names both the sale and the refund number for refund_created", () => {
    const out = formatNotification(
      row({
        type: "refund_created",
        reference_type: "sale",
        data: { receipt_number: "R-000042", refund_number: "RF-000007", total: 20, reason: "Wrong item" },
      }),
      "GHS"
    );
    expect(out.title).toBe("Refund RF-000007 recorded on R-000042");
    expect(out.body).toBe("GH₵20.00 returned — Wrong item.");
  });
});