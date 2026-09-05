import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { toCsv, csvFilename, csvResponseHeaders, UTF8_BOM, type CsvRow } from "@/lib/reports/csv";
import { paymentMethodLabel } from "@/lib/validation/sales";

/**
 * Report downloads.
 *
 * THIS IS A REAL ENDPOINT, NOT A RENDERING TRICK. Everything the page
 * does is done again here: the permission is re-checked, the branch id
 * is re-validated against the branches this person can see, and the same
 * database function is called under the same RLS. A URL that someone
 * edits by hand cannot produce a row the caller could not already read —
 * the functions are all SECURITY INVOKER, so the database refuses before
 * this file has to.
 *
 * The extra check that IS this file's own is `reports.export`. Being
 * able to read a figure on screen and being able to walk out with the
 * whole customer list in a spreadsheet are different acts, and the
 * permission catalog has always distinguished them.
 *
 * Dates arrive as YYYY-MM-DD from the page that built the link. They are
 * validated by shape here rather than trusted, and an invalid one is
 * refused instead of being coerced into something plausible — a report
 * covering a period nobody asked for is worse than an error.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const REPORTS = ["profit-loss", "receivables", "stock", "sales"] as const;
type ReportName = (typeof REPORTS)[number];

function isReport(value: string | null): value is ReportName {
  return value !== null && (REPORTS as readonly string[]).includes(value);
}

/** Money as a bare number, so a spreadsheet can add the column up. */
function amount(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const report = url.searchParams.get("report");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const branchParam = url.searchParams.get("branch");

  if (!isReport(report)) {
    return new NextResponse("Unknown report", { status: 400 });
  }
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return new NextResponse("A start and end date are required", { status: 400 });
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await getCurrentBusinessId(supabase);
  } catch {
    // Not signed in, or no business yet. Nothing to export either way,
    // and no detail worth returning.
    return new NextResponse("Not available", { status: 403 });
  }

  const [canView, canExport] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.REPORTS_VIEW),
    hasPermission(supabase, businessId, PERMISSIONS.REPORTS_EXPORT),
  ]);

  if (!canView || !canExport) {
    return new NextResponse("Not available", { status: 403 });
  }

  // A branch id from the URL is honoured only if it is one this person
  // can see. RLS would return nothing for anyone else's branch anyway;
  // this turns a forged id into "all branches" rather than an empty file
  // with no explanation.
  const { data: branchRows } = await supabase
    .from("branches")
    .select("id, timezone, is_main")
    .eq("status", "active");
  const branches = (branchRows ?? []) as unknown as {
    id: string;
    timezone: string | null;
    is_main: boolean;
  }[];
  const branchId = branches.some((b) => b.id === branchParam) ? branchParam : null;
  const timezone =
    branches.find((b) => b.id === branchId)?.timezone ??
    branches.find((b) => b.is_main)?.timezone ??
    "Africa/Accra";

  let header: CsvRow = [];
  let rows: CsvRow[] = [];

  try {
    if (report === "profit-loss") {
      const [{ data: plRows, error }, { data: categoryRows }] = await Promise.all([
        supabase.rpc("profit_and_loss", {
          p_from: from,
          p_to: to,
          p_branch_id: branchId,
          p_timezone: timezone,
        }),
        supabase.rpc("expenses_by_category", {
          p_from: from,
          p_to: to,
          p_branch_id: branchId,
          p_limit: 100,
        }),
      ]);
      if (error) throw error;

      const pl = ((plRows ?? []) as unknown as Record<string, number | string | boolean>[])[0];
      const categories = (categoryRows ?? []) as unknown as {
        category_name: string;
        amount: number | string;
      }[];

      // One label/amount pair per line: this opens as a statement in
      // Excel rather than as a single unreadable wide row.
      header = ["Line", "Amount"];
      rows = [
        ["Sales", amount(pl?.gross_sales as number)],
        ["Less returns", amount(pl?.refunds as number)],
        ["Net sales", amount(pl?.net_sales as number)],
        ["Cost of goods sold", amount(pl?.cost_of_goods as number)],
        ["Gross profit", amount(pl?.gross_profit as number)],
        ...categories.map((c): CsvRow => [`Expense: ${c.category_name}`, amount(c.amount)]),
        ["Total expenses", amount(pl?.expense_total as number)],
        ["Net profit", amount(pl?.net_profit as number)],
        [],
        ["Sales count", amount(pl?.sale_count as number)],
        ["Items sold", amount(pl?.items_sold as number)],
        ["Paid out of the till", amount(pl?.cash_expenses as number)],
        ["Some costs estimated", pl?.any_cost_estimated ? "yes" : "no"],
      ];
    } else if (report === "receivables") {
      const { data, error } = await supabase.rpc("receivables_aging", {
        p_as_of: null,
        p_timezone: timezone,
      });
      if (error) throw error;

      header = ["Customer", "Phone", "Owed", "Current", "30 days", "60 days", "90+ days", "Oldest unpaid", "Credit limit"];
      rows = ((data ?? []) as unknown as Record<string, number | string | null>[]).map((row): CsvRow => [
        row.customer_name as string,
        row.phone as string | null,
        amount(row.total_owed),
        amount(row.current_amount),
        amount(row.days_30),
        amount(row.days_60),
        amount(row.days_90_plus),
        row.oldest_unpaid as string | null,
        amount(row.credit_limit),
      ]);
    } else if (report === "stock") {
      const { data, error } = await supabase.rpc("stock_valuation", {
        p_branch_id: branchId,
        // The whole stockroom, not the page shown on screen: a download
        // that silently stops at 200 lines is a download nobody can
        // reconcile against the total printed above it.
        p_limit: 2000,
      });
      if (error) throw error;

      header = ["Product", "SKU", "Branch", "Quantity", "Cost each", "Sells for", "At cost", "At retail"];
      rows = ((data ?? []) as unknown as Record<string, number | string | null>[]).map((row): CsvRow => [
        row.product_name as string,
        row.sku as string | null,
        row.branch_name as string,
        amount(row.quantity),
        amount(row.cost_price),
        amount(row.selling_price),
        amount(row.cost_value),
        amount(row.retail_value),
      ]);
    } else {
      const fromIso = new Date(`${from}T00:00:00Z`).toISOString();
      // Exclusive end, so the last day is wholly inside the period.
      const toDate = new Date(`${to}T00:00:00Z`);
      toDate.setUTCDate(toDate.getUTCDate() + 1);
      const rpcArgs = { p_from: fromIso, p_to: toDate.toISOString(), p_branch_id: branchId };

      const [{ data: productRows, error }, { data: paymentRows }, { data: staffRows }] = await Promise.all([
        supabase.rpc("top_products", { ...rpcArgs, p_limit: 50 }),
        supabase.rpc("payment_method_breakdown", rpcArgs),
        supabase.rpc("staff_performance", { ...rpcArgs, p_limit: 50 }),
      ]);
      if (error) throw error;

      const products = (productRows ?? []) as unknown as Record<string, number | string | null>[];
      const payments = (paymentRows ?? []) as unknown as Record<string, number | string>[];
      const staff = (staffRows ?? []) as unknown as Record<string, number | string | null>[];

      // Three tables in one file, separated by blank lines and their own
      // headings. A bookkeeper reading it in Excel can see where each
      // section starts; three separate downloads is three files to lose.
      header = ["Section", "Name", "Detail", "Quantity", "Amount", "Profit"];
      rows = [
        ...products.map((row): CsvRow => [
          "Product",
          row.product_name as string,
          row.sku as string | null,
          amount(row.quantity_sold),
          amount(row.revenue),
          amount(row.gross_profit),
        ]),
        [],
        ...payments.map((row): CsvRow => [
          "Payment",
          paymentMethodLabel(String(row.method)),
          `${amount(row.tender_count)} payments`,
          amount(row.tender_count),
          amount(row.amount),
          null,
        ]),
        [],
        ...staff.map((row): CsvRow => [
          "Cashier",
          [row.first_name, row.last_name].filter(Boolean).join(" ") || "Unnamed user",
          `${amount(row.refunded_total)} returned`,
          amount(row.sale_count),
          amount(row.net_total),
          null,
        ]),
      ];
    }
  } catch (err) {
    // Logged with detail, returned without any. A database error message
    // names functions and columns, and this response goes to a browser.
    console.error("reports/export: query failed", err);
    return new NextResponse("That report could not be built", { status: 500 });
  }

  const filename = csvFilename(report, from, to);
  return new NextResponse(UTF8_BOM + toCsv(header, rows), {
    headers: csvResponseHeaders(filename),
  });
}