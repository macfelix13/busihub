import { describe, expect, it } from "vitest";
import { toCsv, csvFilename, csvResponseHeaders, UTF8_BOM } from "@/lib/reports/csv";

/**
 * CSV export.
 *
 * The formula-injection tests are the point of this file. Busihub lets
 * people type product names, customer names and expense descriptions,
 * and all three end up in a file that gets emailed to a bookkeeper and
 * opened in Excel — where a cell starting with `=` is executed, not
 * displayed. Everything else here is quoting, which is merely the
 * difference between a usable file and a scrambled one.
 */

describe("toCsv", () => {
  it("writes a header and rows with CRLF endings", () => {
    const csv = toCsv(["Name", "Amount"], [["Rice", 100]]);
    expect(csv).toBe("Name,Amount\r\nRice,100\r\n");
  });

  it("quotes a value containing a comma", () => {
    // Without this the column shifts and every figure to its right lands
    // under the wrong heading.
    const csv = toCsv(["Product", "Cost"], [["Rice, 5kg", 30]]);
    expect(csv).toBe('Product,Cost\r\n"Rice, 5kg",30\r\n');
  });

  it("doubles a quotation mark inside a quoted value", () => {
    const csv = toCsv(["Note"], [['He said "pay Friday"']]);
    expect(csv).toBe('Note\r\n"He said ""pay Friday"""\r\n');
  });

  it("quotes a value containing a newline", () => {
    const csv = toCsv(["Note"], [["line one\nline two"]]);
    expect(csv).toBe('Note\r\n"line one\nline two"\r\n');
  });

  it("writes an empty cell for null and undefined", () => {
    const csv = toCsv(["A", "B", "C"], [[null, undefined, ""]]);
    expect(csv).toBe("A,B,C\r\n,,\r\n");
  });

  it("neutralises a cell that a spreadsheet would run as a formula", () => {
    // The realistic version: someone names a product to make the
    // accountant's spreadsheet fetch a URL when they open the file.
    const csv = toCsv(["Product"], [['=HYPERLINK("http://evil.example","Click me")']]);
    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/);
  });

  it("neutralises every formula-leading character", () => {
    for (const prefix of ["=", "+", "-", "@", "\t", "\r"]) {
      const csv = toCsv(["X"], [[`${prefix}cmd`]]);
      const body = csv.split("\r\n")[1] ?? "";
      // The apostrophe must come before the dangerous character, whether
      // or not the cell also needed quoting.
      expect(body.replace(/^"/, "").startsWith("'")).toBe(true);
    }
  });

  it("leaves a negative NUMBER alone", () => {
    // A refund column is full of these. Prefixing them would turn the
    // accountant's numbers into text and break every sum in the sheet.
    const csv = toCsv(["Amount"], [[-150.5]]);
    expect(csv).toBe("Amount\r\n-150.5\r\n");
  });

  it("still guards a negative number that arrives as a string", () => {
    // Which is how it would arrive from a database driver returning
    // numeric as text — the case that makes the number/string split
    // worth testing rather than assuming.
    const csv = toCsv(["Amount"], [["-150.50"]]);
    expect(csv).toBe("Amount\r\n'-150.50\r\n");
  });

  it("drops a non-finite number rather than writing NaN into a money column", () => {
    expect(toCsv(["A"], [[Number.NaN]])).toBe("A\r\n\r\n");
    expect(toCsv(["A"], [[Number.POSITIVE_INFINITY]])).toBe("A\r\n\r\n");
  });

  it("handles a report with no rows", () => {
    expect(toCsv(["Name", "Amount"], [])).toBe("Name,Amount\r\n");
  });
});

describe("csvFilename", () => {
  it("builds a filename that will save on Windows", () => {
    expect(csvFilename("profit-loss", "2026-08-01", "2026-08-31")).toBe(
      "busihub-profit-loss-2026-08-01-to-2026-08-31.csv"
    );
  });

  it("strips characters Windows refuses in a filename", () => {
    const name = csvFilename('Profit & loss: "August"', "2026/08/01", "2026-08-31");
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name.endsWith(".csv")).toBe(true);
  });

  it("does not leave stray separators at the edges", () => {
    expect(csvFilename("  stock  ", "2026-08-01", "2026-08-31")).toBe(
      "busihub-stock-2026-08-01-to-2026-08-31.csv"
    );
  });
});

describe("csvResponseHeaders", () => {
  it("tells the browser to save rather than render", () => {
    const headers = csvResponseHeaders("busihub-stock-2026-08-01-to-2026-08-31.csv");
    expect(headers["Content-Type"]).toContain("text/csv");
    expect(headers["Content-Disposition"]).toContain("attachment");
    expect(headers["Content-Disposition"]).toContain("busihub-stock");
  });

  it("refuses to let a report be cached", () => {
    // A cached report is a stale one, and a stale P&L is the kind of
    // wrong number someone makes a decision on.
    expect(csvResponseHeaders("x.csv")["Cache-Control"]).toBe("no-store");
  });
});

describe("UTF8_BOM", () => {
  it("is the byte-order mark Excel needs to read UTF-8", () => {
    // Without it, a name like "Kofi Owusu-Ansah" with any accented
    // character opens as mojibake in Excel on Windows.
    expect(UTF8_BOM).toBe("﻿");
    expect(UTF8_BOM.length).toBe(1);
  });
});