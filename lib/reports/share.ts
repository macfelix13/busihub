import { wrap } from "@/lib/receipts/format";

/**
 * Reports as plain text, for sending over WhatsApp.
 *
 * The same reasoning as receipts (lib/receipts/format.ts): what leaves a
 * Ghanaian shop goes out over WhatsApp, and WhatsApp wants text. A PDF
 * attachment is something the recipient has to download on mobile data
 * and open in another app; a message is something they read.
 *
 * So this is deliberately narrow — 38 characters, which is about what
 * fits in a phone chat bubble without WhatsApp rewrapping it and
 * scrambling the alignment. Anything wider looks fine on the sender's
 * laptop and arrives as a mess.
 *
 * Pure functions with no database and no formatting of money: the caller
 * passes strings already formatted in the business's currency, so this
 * file cannot disagree with what is on screen.
 */

export const SHARE_WIDTH = 38;

export interface ShareLine {
  label: string;
  value: string;
  /** Draws a rule above it — for a subtotal or a bottom line. */
  rule?: boolean;
  /** A blank line before it, to break up a long list. */
  spaceBefore?: boolean;
}

/**
 * `Label..........value`, with the value hard against the right.
 *
 * A label long enough to collide with its value wraps rather than
 * pushing the number off the line — a report where one long product name
 * breaks the column alignment is a report nobody trusts the totals in.
 */
function pair(label: string, value: string, width: number): string[] {
  const available = width - value.length - 1;
  if (available < 4) {
    // Nothing sensible fits side by side; stack them instead.
    return [label, value.padStart(width)];
  }
  if (label.length <= available) {
    return [label + " ".repeat(width - label.length - value.length) + value];
  }
  const wrapped = wrap(label, width);
  const last = wrapped.pop() ?? "";
  if (last.length <= available) {
    return [...wrapped, last + " ".repeat(width - last.length - value.length) + value];
  }
  return [...wrapped, last, value.padStart(width)];
}

function centre(text: string, width: number): string {
  if (text.length >= width) return text;
  return " ".repeat(Math.floor((width - text.length) / 2)) + text;
}

export interface ShareReport {
  shopName: string;
  title: string;
  periodLabel: string;
  branchLabel?: string;
  lines: ShareLine[];
  /** Printed under the figures — a caveat, or what the numbers exclude. */
  footnotes?: string[];
}

export function formatReportText(report: ShareReport, width: number = SHARE_WIDTH): string {
  const out: string[] = [];

  for (const line of wrap(report.shopName, width)) out.push(centre(line, width));
  for (const line of wrap(report.title, width)) out.push(centre(line, width));
  for (const line of wrap(report.periodLabel, width)) out.push(centre(line, width));
  if (report.branchLabel) {
    for (const line of wrap(report.branchLabel, width)) out.push(centre(line, width));
  }
  out.push("-".repeat(width));

  for (const line of report.lines) {
    if (line.spaceBefore) out.push("");
    if (line.rule) out.push("-".repeat(width));
    out.push(...pair(line.label, line.value, width));
  }

  if (report.footnotes && report.footnotes.length > 0) {
    out.push("");
    for (const note of report.footnotes) {
      out.push(...wrap(note, width));
    }
  }

  out.push("");
  out.push(centre("Sent from Busihub", width));

  // Trailing spaces are invisible on screen and survive into the pasted
  // message, where they push short lines around.
  return out.map((line) => line.replace(/\s+$/, "")).join("\n");
}