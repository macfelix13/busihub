import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { describeBalance } from "@/lib/validation/customers";

export const metadata = { title: "Customers" };

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; owing?: string }>;
}) {
  const { q, status, owing } = await searchParams;
  const activeStatus = status === "archived" ? "archived" : "active";
  const owingOnly = owing === "1";

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

  let query = supabase
    .from("customers")
    .select("id, name, phone, email, credit_limit, status")
    .eq("status", activeStatus)
    .order("name", { ascending: true });

  if (q && q.trim().length > 0) {
    // Match a name OR a phone number, since the till looks people up by
    // whichever they give. `or` needs the PostgREST filter syntax.
    const term = q.trim().replace(/[(),]/g, "");
    query = query.or(`name.ilike.%${term}%,phone.ilike.%${term}%`);
  }

  const [{ data: customers, error }, { data: balances, error: balancesError }] = await Promise.all([
    query,
    supabase.from("customer_balances").select("customer_id, balance"),
  ]);

  if (error) console.error("CustomersPage: customers query failed", error);
  if (balancesError) console.error("CustomersPage: balances query failed", balancesError);

  const balanceByCustomer = new Map<string, number>(
    (balances ?? []).map((b) => [
      (b as { customer_id: string }).customer_id,
      // numeric(14,2) arrives from PostgREST as a string, not a number.
      Number((b as { balance: number | string }).balance),
    ])
  );

  const rows = (customers ?? [])
    .map((c) => ({ customer: c, balance: balanceByCustomer.get(c.id) ?? 0 }))
    .filter((r) => (owingOnly ? r.balance > 0 : true));

  const totalOwed = rows.reduce((sum, r) => sum + (r.balance > 0 ? r.balance : 0), 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Customers</h1>
          <p className="text-neutral-500">
            {totalOwed > 0
              ? `${formatMoney(toMinorUnits(totalOwed), currencyCode)} owed across ${rows.filter((r) => r.balance > 0).length} customer(s).`
              : "People who buy from you."}
          </p>
        </div>
        {canEdit ? (
          <Link href="/customers/new">
            <Button>Add customer</Button>
          </Link>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1 rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
          <Link
            href={{ pathname: "/customers", query: { ...(q ? { q } : {}) } }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              activeStatus === "active" && !owingOnly ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            All
          </Link>
          <Link
            href={{ pathname: "/customers", query: { owing: "1", ...(q ? { q } : {}) } }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              owingOnly ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            Owing
          </Link>
          <Link
            href={{ pathname: "/customers", query: { status: "archived", ...(q ? { q } : {}) } }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              activeStatus === "archived" ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            Archived
          </Link>
        </div>
        <form className="flex flex-wrap gap-2" action="/customers">
          {activeStatus === "archived" ? <input type="hidden" name="status" value="archived" /> : null}
          {owingOnly ? <input type="hidden" name="owing" value="1" /> : null}
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search name or phone…"
            className="min-h-[44px] w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white sm:w-56"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load customers. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {rows.length > 0 ? (
              rows.map(({ customer, balance }) => {
                const state = describeBalance(balance);
                return (
                  <li key={customer.id}>
                    <Link
                      href={`/customers/${customer.id}`}
                      className="flex flex-col gap-1 px-5 py-4 hover:bg-neutral-50 sm:flex-row sm:items-center sm:justify-between dark:hover:bg-neutral-800/50"
                    >
                      <div>
                        <span className="font-medium">{customer.name}</span>
                        <p className="mt-0.5 text-sm text-neutral-500">{customer.phone || "No phone"}</p>
                      </div>
                      <p
                        className={`text-sm font-medium tabular-nums ${
                          state.owing
                            ? "text-red-600 dark:text-red-400"
                            : state.inCredit
                              ? "text-green-700 dark:text-green-400"
                              : "text-neutral-500"
                        }`}
                      >
                        {balance === 0
                          ? "Settled"
                          : `${formatMoney(toMinorUnits(Math.abs(balance)), currencyCode)} ${state.label}`}
                      </p>
                    </Link>
                  </li>
                );
              })
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500">
                {owingOnly
                  ? "Nobody owes anything right now."
                  : activeStatus === "archived"
                    ? "No archived customers."
                    : "No customers yet."}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}