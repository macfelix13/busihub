import { formatMoney, toMinorUnits } from "@/lib/money/money";

/**
 * A receipt as plain text.
 *
 * This exists for two reasons, and the second is the real one.
 *
 * The obvious reason is sharing: in a Ghanaian shop the customer's copy
 * usually goes out over WhatsApp, and WhatsApp wants text, not a PDF or a
 * screenshot. So the cashier copies this and sends it.
 *
 * The less obvious reason is that receipt layout is arithmetic — columns
 * that must line up inside a fixed character width on a thermal printer —
 * and arithmetic in a React component is arithmetic nobody tests. Keeping
 * it here as a pure function means the alignment, the truncation of long
 * product names, and the totals can be checked without rendering
 * anything.
 *
 * Widths are the printable character counts for the two common Ghanaian
 * thermal rolls at the usual font, plus a wider one for A4.
 */

export const RECEIPT_WIDTHS = {
  thermal_58mm: 32,
  thermal_80mm: 42,
  a4: 60,
} as const;

export type PaperSize = keyof typeof RECEIPT_WIDTHS;

export function receiptWidth(paperSize: string): number {
  return RECEIPT_WIDTHS[paperSize as PaperSize] ?? RECEIPT_WIDTHS.thermal_80mm;
}

export interface ReceiptLine {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface ReceiptPayment {
  method: string;
  amount: number;
  status: string;
}

export interface ReceiptData {
  businessName: string;
  branchName: string | null;
  addressLines: string[];
  phone: string | null;
  receiptNumber: string;
  soldAt: Date;
  cashierName: string | null;
  customerName: string | null;
  lines: ReceiptLine[];
  subtotal: number;
  taxTotal: number;
  total: number;
  amountTendered: number;
  changeGiven: number;
  payments: ReceiptPayment[];
  refundedTotal: number;
  status: string;
  currencyCode: string;
  footerMessage: string;
}

/**
 * Centres within the width. A string longer than the roll is WRAPPED, not
 * left to overflow — an overflowing line does not fail loudly on screen,
 * it just prints wrong, which is the worst kind of wrong for a receipt.
 */
function centreLines(text: string, width: number): string[] {
  return wrap(text, width).map((chunk) => {
    const left = Math.floor((width - chunk.length) / 2);
    return " ".repeat(Math.max(left, 0)) + chunk;
  });
}

/**
 * Left text, right text, dots of space between. If the two would collide,
 * the LEFT is truncated — the amount is the part a customer checks, and a
 * shortened product name is far less alarming than a mangled price.
 */
function pair(left: string, right: string, width: number): string {
  const room = width - right.length - 1;
  const trimmedLeft = left.length > room ? left.slice(0, Math.max(room, 0)) : left;
  const gap = Math.max(width - trimmedLeft.length - right.length, 1);
  return trimmedLeft + " ".repeat(gap) + right;
}

function rule(width: number, char = "-"): string {
  return char.repeat(width);
}

export function formatQuantityForReceipt(quantity: number): string {
  // Whole numbers read better without ".000" on a narrow roll, but a
  // weighed item must keep its decimals.
  return Number.isInteger(quantity) ? String(quantity) : String(Number(quantity.toFixed(3)));
}

export function paymentMethodText(method: string): string {
  if (method === "momo") return "Mobile money";
  if (method === "credit") return "On account";
  if (method === "cash") return "Cash";
  return method;
}

export function formatReceiptText(data: ReceiptData, width: number): string {
  const money = (amount: number) => formatMoney(toMinorUnits(amount), data.currencyCode);
  const out: string[] = [];

  out.push(...centreLines(data.businessName.toUpperCase(), width));
  if (data.branchName) out.push(...centreLines(data.branchName, width));
  for (const line of data.addressLines) out.push(...centreLines(line, width));
  if (data.phone) out.push(...centreLines(data.phone, width));
  out.push("");

  out.push(pair("Receipt", data.receiptNumber, width));
  out.push(
    pair(
      "Date",
      data.soldAt.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      width
    )
  );
  if (data.cashierName) out.push(pair("Served by", data.cashierName, width));
  if (data.customerName) out.push(pair("Customer", data.customerName, width));

  out.push(rule(width));

  for (const line of data.lines) {
    // Name on its own line, then quantity × price and the line total —
    // the layout every thermal receipt uses, because a product name and
    // three numbers will not fit across 32 characters.
    // Wrapped, not truncated: a shopkeeper needs to recognise the item,
    // and the roll has room on a second line.
    out.push(...wrap(line.description, width));
    out.push(pair(`  ${formatQuantityForReceipt(line.quantity)} x ${money(line.unitPrice)}`, money(line.lineTotal), width));
  }

  out.push(rule(width));
  out.push(pair("Subtotal", money(data.subtotal), width));
  if (data.taxTotal > 0) out.push(pair("Tax", money(data.taxTotal), width));
  out.push(pair("TOTAL", money(data.total), width));

  for (const payment of data.payments) {
    const label = paymentMethodText(payment.method);
    const suffix = payment.status === "success" ? "" : ` (${payment.status})`;
    out.push(pair(`${label}${suffix}`, money(payment.amount), width));
  }

  if (data.changeGiven > 0) {
    out.push(pair("Change", money(data.changeGiven), width));
  }

  if (data.refundedTotal > 0) {
    out.push(rule(width));
    out.push(pair("Returned", `-${money(data.refundedTotal)}`, width));
    out.push(pair("Net", money(data.total - data.refundedTotal), width));
  }

  if (data.status === "voided") {
    out.push(rule(width));
    out.push(...centreLines("*** VOIDED ***", width));
  }
  if (data.status === "awaiting_payment") {
    out.push(rule(width));
    out.push(...centreLines("*** NOT YET PAID ***", width));
  }
  if (data.status === "cancelled") {
    out.push(rule(width));
    out.push(...centreLines("*** CANCELLED ***", width));
  }

  if (data.footerMessage.trim()) {
    out.push("");
    // A footer longer than the roll is wrapped rather than clipped.
    out.push(...centreLines(data.footerMessage.trim(), width));
  }

  return out.join("\n");
}

/** Greedy word wrap. A single word longer than the width is hard-split. */
export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      let rest = word;
      while (rest.length > width) {
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      current = rest;
      continue;
    }
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}
