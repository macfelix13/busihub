import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { AccountEntryForm } from "../../account-entry-form";
import { recordCharge } from "../../actions";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { describeBalance } from "@/lib/validation/customers";

export const metadata = { title: "Add charge" };

export default async function RecordChargePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canEdit, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.CUSTOMERS_EDIT),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
  ]);

  // Cosmetic — recordCharge() re-checks this server-side regardless.
  if (!canEdit) {
    redirect(`/customers/${id}`);
  }

  const [{ data: customer, error }, { data: balanceRow }, { data: branches }] = await Promise.all([
    supabase.from("customers").select("id, name").eq("id", id).maybeSingle(),
    supabase.from("customer_balances").select("balance").eq("customer_id", id).maybeSingle(),
    supabase.from("branches").select("id, name, is_main").eq("status", "active").order("is_main", { ascending: false }),
  ]);

  if (error) {
    console.error("RecordChargePage: query failed", error);
  }

  if (!customer) {
    notFound();
  }

  const currencyCode = business?.currency_code ?? "GHS";
  const balance = Number(balanceRow?.balance ?? 0);
  const state = describeBalance(balance);
  const label =
    balance === 0
      ? `${customer.name} is settled up.`
      : `${customer.name} is currently ${formatMoney(toMinorUnits(Math.abs(balance)), currencyCode)} ${state.label}.`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Add charge</h1>
        <p className="text-neutral-500">{customer.name}</p>
      </div>
      <AccountEntryForm
        mode="charge"
        action={recordCharge.bind(null, customer.id)}
        branches={branches ?? []}
        currencyCode={currencyCode}
        currentBalanceLabel={label}
      />
    </div>
  );
}
