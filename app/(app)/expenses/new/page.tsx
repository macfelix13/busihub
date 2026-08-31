import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { ExpenseForm } from "../expense-form";
import { recordExpense } from "../actions";

export const metadata = { title: "Record expense" };

/** Today in the given zone, as YYYY-MM-DD. */
function todayIn(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Accra",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }
}

export default async function NewExpensePage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canCreate, { data: business }, { data: branchRows }, { data: categoryRows }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.EXPENSES_CREATE),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
    supabase
      .from("branches")
      .select("id, name, is_main, timezone")
      .eq("status", "active")
      .order("is_main", { ascending: false }),
    supabase
      .from("expense_categories")
      .select("id, name")
      .eq("status", "active")
      .order("name"),
  ]);

  // Cosmetic — recordExpense() re-checks this server-side, and the RLS
  // policy on the table refuses regardless of what either check says.
  if (!canCreate) {
    redirect("/expenses");
  }

  const branches = (branchRows ?? []) as unknown as {
    id: string;
    name: string;
    is_main: boolean;
    timezone: string | null;
  }[];
  const categories = (categoryRows ?? []) as unknown as { id: string; name: string }[];

  // The shop's own day, not the server's. A shop in UTC+3 recording
  // tonight's purchase would otherwise be handed tomorrow's date by a
  // UTC server and refused for being in the future.
  const timezone = branches.find((b) => b.is_main)?.timezone ?? branches[0]?.timezone ?? "Africa/Accra";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Record expense</h1>
        <p className="text-neutral-500">Money that has left the business. It counts against profit straight away.</p>
      </div>

      {branches.length === 0 ? (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          You need a branch before you can record an expense against one.
        </p>
      ) : (
        <ExpenseForm
          action={recordExpense}
          branches={branches.map((b) => ({ value: b.id, label: b.name }))}
          categories={categories.map((c) => ({ value: c.id, label: c.name }))}
          currencyCode={business?.currency_code ?? "GHS"}
          today={todayIn(timezone)}
        />
      )}
    </div>
  );
}