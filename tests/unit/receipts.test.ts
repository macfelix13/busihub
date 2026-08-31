import { describe, expect, it } from "vitest";
import {
  formatReceiptText,
  formatQuantityForReceipt,
  paymentMethodText,
  receiptWidth,
  wrap,
  type ReceiptData,
} from "@/lib/receipts/format";

const base: ReceiptData = {
  businessName: "Busihub Demo Store",
  branchName: "Main",
  addressLines: ["12 Oxford Street", "Osu, Greater Accra"],
  phone: "024 412 3456",
  receiptNumber: "R-000042",
  soldAt: new Date("2026-08-30T14:05:00Z"),
  cashierName: "Ama Mensah",
  customerName: null,
  lines: [
    { description: "Rice 5kg", quantity: 2, unitPrice: 60, lineTotal: 120 },
    { description: "Sugar 1kg", quantity: 1, unitPrice: 20, lineTotal: 20 },
  ],
  subtotal: 121.74,
  taxTotal: 18.26,
  total: 140,
  amountTendered: 200,
  changeGiven: 60,
  payments: [{ method: "cash", amount: 200, status: "success" }],
  refundedTotal: 0,
  status: "completed",
  currencyCode: "GHS",
  footerMessage: "Thank you for your business!",
};

function linesOf(data: Partial<ReceiptData>, width = 42): string[] {
  return formatReceiptText({ ...base, ...data }, width).split("\n");
}

describe("formatReceiptText", () => {
  it("never exceeds the paper width", () => {
    for (const width of [32, 42, 60]) {
      for (const line of linesOf({}, width)) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps every amount flush to the right edge", () => {
    // The point of a receipt: the column of money lines up. A total that
    // drifts by a character is how a customer loses confidence in it.
    const lines = linesOf({}, 42).filter((l) => l.includes("GH₵"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it("shows the shop, the receipt number and who served", () => {
    const text = formatReceiptText(base, 42);
    expect(text).toContain("BUSIHUB DEMO STORE");
    expect(text).toContain("R-000042");
    expect(text).toContain("Ama Mensah");
    expect(text).toContain("Thank you for your business!");
  });

  it("totals what the sale says, not a recomputation", () => {
    // The receipt is a rendering of stored figures. If it ever starts
    // doing its own arithmetic, this is where it shows up.
    const text = formatReceiptText({ ...base, total: 999.99 }, 42);
    expect(text).toContain("999.99");
  });

  it("puts the item name on its own line so long names are not mangled", () => {
    const lines = linesOf({
      lines: [
        {
          description: "Extra Special Long Grain Aromatic Basmati Rice 25kg Sack",
          quantity: 1,
          unitPrice: 500,
          lineTotal: 500,
        },
      ],
    }, 32);
    // The name is truncated only on the quantity line, never silently
    // merged into the price column.
    expect(lines.some((l) => l.startsWith("Extra Special"))).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(32);
  });

  it("drops the tax line when there is no tax", () => {
    expect(formatReceiptText({ ...base, taxTotal: 0 }, 42)).not.toContain("Tax");
  });

  it("shows change only when there is change", () => {
    expect(formatReceiptText(base, 42)).toContain("Change");
    expect(formatReceiptText({ ...base, changeGiven: 0 }, 42)).not.toContain("Change");
  });

  it("names every tender on a split sale", () => {
    const text = formatReceiptText(
      {
        ...base,
        payments: [
          { method: "cash", amount: 60, status: "success" },
          { method: "momo", amount: 80, status: "success" },
        ],
        changeGiven: 0,
      },
      42
    );
    expect(text).toContain("Cash");
    expect(text).toContain("Mobile money");
  });

  it("marks a tender that has not landed, rather than implying it has", () => {
    const text = formatReceiptText(
      { ...base, payments: [{ method: "momo", amount: 140, status: "pending" }], changeGiven: 0 },
      42
    );
    expect(text).toContain("(pending)");
  });

  it("says plainly when a sale is voided, unpaid or cancelled", () => {
    expect(formatReceiptText({ ...base, status: "voided" }, 42)).toContain("VOIDED");
    expect(formatReceiptText({ ...base, status: "awaiting_payment" }, 42)).toContain("NOT YET PAID");
    expect(formatReceiptText({ ...base, status: "cancelled" }, 42)).toContain("CANCELLED");
    expect(formatReceiptText(base, 42)).not.toContain("***");
  });

  it("shows returns and the net, so the slip matches the money that moved", () => {
    const text = formatReceiptText({ ...base, refundedTotal: 40 }, 42);
    expect(text).toContain("Returned");
    expect(text).toContain("Net");
    expect(text).toContain("100.00");
  });

  it("survives a sale with no cashier, customer, address or footer", () => {
    const text = formatReceiptText(
      {
        ...base,
        branchName: null,
        addressLines: [],
        phone: null,
        cashierName: null,
        customerName: null,
        footerMessage: "",
      },
      32
    );
    expect(text).toContain("R-000042");
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(32);
  });

  it("wraps a footer that is longer than the roll instead of clipping it", () => {
    const text = formatReceiptText(
      { ...base, footerMessage: "Goods sold are not returnable after seven days without a valid receipt" },
      32
    );
    expect(text).toContain("Goods sold");
    expect(text).toContain("receipt");
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(32);
  });
});

describe("receiptWidth", () => {
  it("matches the common Ghanaian thermal rolls", () => {
    expect(receiptWidth("thermal_58mm")).toBe(32);
    expect(receiptWidth("thermal_80mm")).toBe(42);
    expect(receiptWidth("a4")).toBe(60);
  });

  it("falls back to 80mm for an unknown setting rather than crashing a sale", () => {
    expect(receiptWidth("something_new")).toBe(42);
  });
});

describe("formatQuantityForReceipt", () => {
  it("drops meaningless decimals but keeps a weighed quantity", () => {
    expect(formatQuantityForReceipt(2)).toBe("2");
    expect(formatQuantityForReceipt(1.5)).toBe("1.5");
    expect(formatQuantityForReceipt(0.125)).toBe("0.125");
  });
});

describe("paymentMethodText", () => {
  it("reads as a shopkeeper would say it", () => {
    expect(paymentMethodText("momo")).toBe("Mobile money");
    expect(paymentMethodText("credit")).toBe("On account");
    expect(paymentMethodText("cash")).toBe("Cash");
    expect(paymentMethodText("something")).toBe("something");
  });
});

describe("wrap", () => {
  it("breaks on words", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  it("hard-splits a word too long to fit", () => {
    expect(wrap("supercalifragilistic", 8)).toEqual(["supercal", "ifragili", "stic"]);
  });

  it("returns nothing for empty text", () => {
    expect(wrap("   ", 10)).toEqual([]);
  });
});
