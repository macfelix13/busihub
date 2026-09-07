import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { formatReceiptText, receiptWidth, type ReceiptData } from "@/lib/receipts/format";
import { ReceiptControls } from "./receipt-controls";

export const metadata = { title: "Receipt" };

/**
 * The customer's copy.
 *
 * Rendered as a <pre> of the very same text the "copy for WhatsApp"
 * button puts on the clipboard — not a second HTML layout that happens to
 * look similar. One layout means the printed slip and the shared message
 * can never quietly disagree about a total, and it is the layout that has
 * unit tests.
 *
 * The width comes from the shop's paper setting, so a 58mm roll gets 32
 * characters and an 80mm roll 42, which is what makes the columns line up
 * on the actual printer rather than only on screen.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canSell, canReport, { data: business }, { data: settings }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.SALES_PROCESS),
    hasPermission(supabase, businessId, PERMISSIONS.REPORTS_VIEW),
    supabase
      .from("businesses")
      .select("name, currency_code, logo_url, phone, address_line1, address_line2, city, region")
      .eq("id", businessId)
      .maybeSingle(),
    supabase.from("business_settings").select("receipt_settings").eq("business_id", businessId).maybeSingle(),
  ]);

  if (!canSell && !canReport) {
    redirect("/dashboard");
  }

  const { data: saleData, error } = await supabase
    .from("sales")
    .select(
      "id, receipt_number, status, payment_method, subtotal, tax_total, total, amount_tendered, change_given, created_at, branches(name), customers(name), cashier:profiles!sales_cashier_id_fkey(first_name, last_name)"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("ReceiptPage: sale query failed", error);
  }

  if (!saleData) {
    notFound();
  }

  const sale = saleData as unknown as {
    id: string;
    receipt_number: string;
    status: string;
    payment_method: string;
    subtotal: number | string;
    tax_total: number | string;
    total: number | string;
    amount_tendered: number | string;
    change_given: number | string;
    created_at: string;
    branches: { name: string } | null;
    customers: { name: string } | null;
    cashier: { first_name: string | null; last_name: string | null } | null;
  };

  const [{ data: items }, { data: payments }, { data: refunds }] = await Promise.all([
    supabase.from("sale_items").select("description, quantity, unit_price, line_total").eq("sale_id", id),
    supabase.from("sale_payments").select("method, amount, status").eq("sale_id", id).order("created_at"),
    supabase.from("refunds").select("total").eq("sale_id", id),
  ]);

  const receiptSettings = (settings?.receipt_settings ?? {}) as {
    footer_message?: string;
    show_logo?: boolean;
    paper_size?: string;
  };

  const biz = business as {
    name: string;
    currency_code: string;
    logo_url: string | null;
    phone: string | null;
    address_line1: string | null;
    address_line2: string | null;
    city: string | null;
    region: string | null;
  } | null;

  const addressLines = [biz?.address_line1, biz?.address_line2, [biz?.city, biz?.region].filter(Boolean).join(", ")]
    .map((line) => (line ?? "").trim())
    .filter((line) => line.length > 0);

  const cashierName = [sale.cashier?.first_name, sale.cashier?.last_name].filter(Boolean).join(" ");

  const data: ReceiptData = {
    businessName: biz?.name ?? "Busihub",
    branchName: sale.branches?.name ?? null,
    addressLines,
    phone: biz?.phone ?? null,
    receiptNumber: sale.receipt_number,
    soldAt: new Date(sale.created_at),
    cashierName: cashierName || null,
    customerName: sale.customers?.name ?? null,
    lines: ((items ?? []) as unknown as {
      description: string;
      quantity: number | string;
      unit_price: number | string;
      line_total: number | string;
    }[]).map((item) => ({
      description: item.description,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price),
      lineTotal: Number(item.line_total),
    })),
    subtotal: Number(sale.subtotal),
    taxTotal: Number(sale.tax_total),
    total: Number(sale.total),
    amountTendered: Number(sale.amount_tendered),
    changeGiven: Number(sale.change_given),
    payments: ((payments ?? []) as unknown as { method: string; amount: number | string; status: string }[]).map(
      (p) => ({ method: p.method, amount: Number(p.amount), status: p.status })
    ),
    refundedTotal: ((refunds ?? []) as unknown as { total: number | string }[]).reduce(
      (sum, r) => sum + Number(r.total),
      0
    ),
    status: sale.status,
    currencyCode: biz?.currency_code ?? "GHS",
    footerMessage: receiptSettings.footer_message ?? "",
  };

  const paperSize = receiptSettings.paper_size ?? "thermal_80mm";
  const width = receiptWidth(paperSize);
  const text = formatReceiptText(data, width);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        className="print:hidden"
        title="Receipt"
        description={`${sale.receipt_number} · ${paperSize.replace("thermal_", "").replace("a4", "A4")} · ${width} characters wide`}
        actions={
          <Link href={`/sales/${sale.id}`}>
            <Button variant="ghost">Back to the sale</Button>
          </Link>
        }
      />

      <ReceiptControls text={text} />

      {/* The printed area. Everything else on the page is print:hidden, so
          what comes out of the printer is this slip and nothing else. */}
      <div className="receipt-sheet mx-auto w-full max-w-[420px] rounded-2xl border border-neutral-200 bg-white p-5 text-neutral-900 dark:border-neutral-800 print:max-w-none print:rounded-none print:border-0 print:p-0">
        {receiptSettings.show_logo && biz?.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={biz.logo_url}
            alt=""
            className="mx-auto mb-3 max-h-16 w-auto"
          />
        ) : null}
        <pre className="whitespace-pre font-mono text-[12px] leading-[1.35]">{text}</pre>
      </div>

      <p className="text-sm text-neutral-500 print:hidden">
        Printed and shared copies are generated from the same text, so they cannot disagree. Change the shop name,
        address, footer message or paper size in Settings → Business.
      </p>
    </div>
  );
}