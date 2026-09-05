/**
 * CSV for report downloads.
 *
 * Two problems, and the second one is a security problem.
 *
 * QUOTING. A product called `Rice, 5kg` or a customer note containing a
 * quotation mark will silently shift every column to its right if the
 * value is not escaped, and a bookkeeper opening the file has no way to
 * tell that the totals column now holds a phone number. RFC 4180: wrap
 * in double quotes, and double any double quote inside.
 *
 * FORMULA INJECTION. This is the one worth being careful about. Excel,
 * LibreOffice and Google Sheets all treat a cell beginning with `=`,
 * `+`, `-` or `@` as a FORMULA, not as text — and formulas can call out
 * to the network or, with a click-through, run a command. A supplier
 * name typed as `=HYPERLINK("http://…","Click")` becomes a live link in
 * the shop's accountant's spreadsheet; `=cmd|'/c calc'!A1` is the
 * classic proof of the worse case.
 *
 * Busihub lets people type product names, customer names, expense
 * descriptions and notes, and every one of those ends up in a CSV that
 * gets emailed to someone. So a cell that begins with one of those
 * characters is prefixed with an apostrophe, which spreadsheets read as
 * "this is text" and do not display. Tab, carriage return and newline
 * are included because they are the known ways to sneak a leading
 * character past a naive check.
 *
 * Numbers are exempt: a negative amount is `-150.00` and prefixing it
 * would turn the accountant's column into unusable text. They are
 * written by the caller as numbers, and only strings are guarded.
 */

/** Characters a spreadsheet treats as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r\n]/;

/** A single cell, already escaped and quoted as needed. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";

  if (typeof value === "number") {
    // A number is never a formula, and quoting it makes some
    // spreadsheets import the column as text.
    return Number.isFinite(value) ? String(value) : "";
  }

  let text = value;
  if (FORMULA_START.test(text)) {
    text = `'${text}`;
  }

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export type CsvRow = (string | number | null | undefined)[];

/**
 * Build a CSV document from a header row and body rows.
 *
 * CRLF line endings, because that is what RFC 4180 says and what Excel
 * on Windows expects — and Windows is what a Ghanaian shop's accountant
 * is running.
 */
export function toCsv(header: CsvRow, rows: CsvRow[]): string {
  const lines = [header, ...rows].map((row) => row.map(cell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * A filename that survives being saved on Windows, macOS and Android.
 *
 * `Profit & loss — 1 Aug to 31 Aug.csv` is a nicer name and a worse
 * filename: the characters Windows refuses (\ / : * ? " < > |) will
 * produce a save dialog error rather than a file.
 */
export function csvFilename(report: string, from: string, to: string): string {
  const safe = (part: string) => part.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `busihub-${safe(report)}-${safe(from)}-to-${safe(to)}.csv`;
}

/**
 * The headers that make a browser save the response rather than render
 * it. The BOM matters more than it looks: without it, Excel opens a
 * UTF-8 CSV as Windows-1252 and a customer called Kofi Owusu-Ansah with
 * an accented character in their name arrives as mojibake.
 */
export function csvResponseHeaders(filename: string): Record<string, string> {
  return {
    "Content-Type": "text/csv; charset=utf-8",
    // The filename is built by csvFilename() from a fixed report name and
    // ISO dates, so it holds no quotes or newlines to break out of the
    // header with.
    "Content-Disposition": `attachment; filename="${filename}"`,
    // A report is a snapshot of live figures; a cached one is a wrong one.
    "Cache-Control": "no-store",
  };
}

/** Excel needs the byte-order mark to read the file as UTF-8. */
export const UTF8_BOM = "﻿";