import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusToggleButton } from "../../products/status-toggle-button";
import { setCustomerStatus } from "../actions";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { describeBalance, ENTRY_TYPE_LABELS } from "@/lib/validation/customers";

export const metadata = { title: "Customer" };

interface EntryRow {
  id: string;
  amount: number | string;
  entry_type: string;
  note: string | null;
  created_at: string;
  branches: { name: string } | null;
  profiles: { first_name: string | null; last_name: string | null } | null;
}

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canView, canEdit, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.CUSTOMERS_VIEW),
    hasPermission(supabase, businessId, PERMISSIONS.CUSTOMERS_EDIT),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
  ]);
  const currencyCode = business?.currency_code ?? "GHS";

  if (!canView) {
    redirect("/dashboard");
  }

  // RLS-scoped: another tenant's customer id simply isn't found.
  const { data: customer, error } = await supabase
    .from("customers")
    .select("id, name, phone, email, address, notes, credit_limit, status")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("CustomerDetailPage: query failed", error);
  }

  if (!customer) {
    notFound();
  }

  const [{ data: balanceRow }, { data: entries, error: entriesError }] = await Promise.all([
    supabase.from("customer_balances").select("balance").eq("customer_id", id).maybeSingle(),
    supabase
      .from("customer_account_entries")
      .select("id, amount, entry_type, note, created_at, branches(name), profiles(first_name, last_name)")
      .eq("customer_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (entriesError) {
    console.error("CustomerDetailPage: entries query failed", entriesError);
  }

  // numeric(14,2) arrives from PostgREST as a string, not a number.
  const balance = Number(balanceRow?.balance ?? 0);
  const creditLimit = Number(customer.credit_limit);
  const state = describeBalance(balance);
  const headroom = creditLimit - balance;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{customer.name}</h1>
            {customer.status === "archived" ? <Badge variant="neutral">Archived</Badge> : null}
          </div>
          <p className="text-neutral-500 dark:text-ink-muted">{customer.phone || "No phone number"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit ? (
            <>
              <Link href={`/customers/${customer.id}/payment`}>
                <Button>Record payment</Button>
              </Link>
              <Link href={`/customers/${customer.id}/charge`}>
                <Button variant="secondary">Add charge</Button>
              </Link>
              <Link href={`/customers/${customer.id}/edit`}>
                <Button variant="secondary">Edit</Button>
              </Link>
              <StatusToggleButton
                action={setCustomerStatus.bind(null, customer.id, customer.status === "active" ? "archived" : "active")}
                label={customer.status === "active" ? "Archive" : "Restore"}
                pendingLabel="Saving…"
                variant={customer.status === "active" ? "danger" : "secondary"}
              />
            </>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <p className="text-sm text-neutral-500 dark:text-ink-muted">Balance</p>
          <p
            className={`mt-1 text-2xl font-semibold tabular-nums ${
              state.owing ? "text-red-600 dark:text-red-400" : state.inCredit ? "text-green-700 dark:text-green-400" : ""
            }`}
          >
            {formatMoney(toMinorUnits(Math.abs(balance)), currencyCode)}
          </p>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-ink-muted">
            {balance === 0 ? "Settled up" : state.owing ? "owed to you" : "in their favour"}
          </p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-neutral-500 dark:text-ink-muted">Credit limit</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {formatMoney(toMinorUnits(creditLimit), currencyCode)}
          </p>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-ink-muted">{creditLimit === 0 ? "Cash only" : "maximum they may owe"}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-neutral-500 dark:text-ink-muted">Still available</p>
          <p
            className={`mt-1 text-2xl font-semibold tabular-nums ${
              headroom <= 0 ? "text-red-600 dark:text-red-400" : ""
            }`}
          >
            {formatMoney(toMinorUnits(Math.max(headroom, 0)), currencyCode)}
          </p>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-ink-muted">
            {headroom <= 0 ? "at their limit" : "can still be charged"}
          </p>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <dl className="divide-y divide-neutral-100 dark:divide-surface-line">
          {[
            ["Email", customer.email],
            ["Address", customer.address],
            ["Notes", customer.notes],
          ].map(([label, value]) => (
            <div key={label as string} className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
              <dt className="text-sm font-medium text-neutral-500 dark:text-ink-muted">{label}</dt>
              <dd className="whitespace-pre-line text-sm text-neutral-800 dark:text-ink sm:col-span-2">
                {(value as string) || "—"}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      <div>
        <h2 className="font-semibold">Account history</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-ink-muted">
          Everything charged and paid, most recent first. Entries are never edited or deleted — a correction is a new
          entry.
        </p>
        <Card className="mt-3 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase text-neutral-500 dark:text-ink-muted dark:border-surface-line">
                <tr>
                  <th className="px-4 py-3 font-medium">When</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">Note</th>
                  <th className="px-4 py-3 font-medium">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-surface-line">
                {entries && entries.length > 0 ? (
                  (entries as unknown as EntryRow[]).map((entry) => {
                    const amount = Number(entry.amount);
                    const who = [entry.profiles?.first_name, entry.profiles?.last_name].filter(Boolean).join(" ");
                    return (
                      <tr key={entry.id} className="transition-colors hover:bg-neutral-50 dark:hover:bg-surface/60">
                        <td className="px-4 py-3 text-neutral-500 dark:text-ink-muted">
                          {new Date(entry.created_at).toLocaleString("en-GB", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                        <td className="px-4 py-3">{ENTRY_TYPE_LABELS[entry.entry_type] ?? entry.entry_type}</td>
                        <td
                          className={`px-4 py-3 text-right font-medium tabular-nums ${
                            amount > 0 ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-400"
                          }`}
                        >
                          {amount > 0 ? "+" : "−"}
                          {formatMoney(toMinorUnits(Math.abs(amount)), currencyCode)}
                        </td>
                        <td className="px-4 py-3 text-neutral-500 dark:text-ink-muted">{entry.note || "—"}</td>
                        <td className="px-4 py-3 text-neutral-500 dark:text-ink-muted">{who || "—"}</td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-neutral-500 dark:text-ink-muted">
                      Nothing on this account yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
        <p className="mt-2 text-sm text-neutral-500 dark:text-ink-muted">
          A charge (+) increases what they owe; a payment (−) reduces it.
        </p>
      </div>
    </div>
  );
}