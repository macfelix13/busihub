import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { paidFromLabel } from "@/lib/validation/expenses";
import { VoidExpenseForm } from "../void-form";
import { voidExpense } from "../actions";

export const metadata = { title: "Expense" };

interface ExpenseDetail {
  id: string;
  reference_number: string;
  description: string;
  amount: number | string;
  expense_date: string;
  paid_from: string;
  payment_reference: string | null;
  note: string | null;
  status: string;
  void_reason: string | null;
  voided_at: string | null;
  created_at: string;
  branches: { name: string } | null;
  expense_categories: { name: string } | null;
  recorder: { first_name: string | null; last_name: string | null } | null;
  voider: { first_name: string | null; last_name: string | null } | null;
}

function fullName(person: { first_name: string | null; last_name: string | null } | null): string | null {
  const name = [person?.first_name, person?.last_name].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : null;
}

export default async function ExpenseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canView, canVoid, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.EXPENSES_VIEW),
    hasPermission(supabase, businessId, PERMISSIONS.EXPENSES_APPROVE),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
  ]);

  if (!canView) {
    redirect("/dashboard");
  }

  const { data, error } = await supabase
    .from("expenses")
    .select(
      "id, reference_number, description, amount, expense_date, paid_from, payment_reference, note, status, void_reason, voided_at, created_at, branches(name), expense_categories(name), recorder:profiles!expenses_recorded_by_fkey(first_name, last_name), voider:profiles!expenses_voided_by_fkey(first_name, last_name)"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) console.error("ExpenseDetailPage: query failed", error);

  // An expense belonging to another business is filtered out by RLS and
  // arrives here as null — so it reads as "not found" rather than as a
  // refusal, which would confirm the row exists.
  if (!data) notFound();

  const expense = data as unknown as ExpenseDetail;
  const currencyCode = business?.currency_code ?? "GHS";
  const money = (amount: number | string | undefined) => formatMoney(toMinorUnits(amount ?? 0), currencyCode);
  const recorder = fullName(expense.recorder);
  const voider = fullName(expense.voider);

  const rows: { label: string; value: string }[] = [
    {
      label: "Date",
      value: new Date(`${expense.expense_date}T00:00:00`).toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    },
    { label: "Category", value: expense.expense_categories?.name ?? "Uncategorised" },
    { label: "Paid from", value: paidFromLabel(expense.paid_from) },
    { label: "Branch", value: expense.branches?.name ?? "—" },
    ...(expense.payment_reference ? [{ label: "Reference", value: expense.payment_reference }] : []),
    ...(recorder ? [{ label: "Recorded by", value: recorder }] : []),
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/expenses" className="text-sm text-brand-700 hover:underline dark:text-brand-300">
          ← All expenses
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{expense.description}</h1>
            <p className="text-neutral-500 dark:text-ink-muted">{expense.reference_number}</p>
          </div>
          <p
            className={`text-2xl font-semibold tabular-nums ${
              expense.status === "voided" ? "text-neutral-400 line-through dark:text-ink-muted" : ""
            }`}
          >
            {money(expense.amount)}
          </p>
        </div>
      </div>

      {expense.status === "voided" ? (
        <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-5 dark:border-surface-line dark:bg-surface-card">
          <h2 className="font-semibold">Voided</h2>
          <p className="mt-1 text-sm text-neutral-600 dark:text-ink-muted">
            {expense.void_reason}
            {voider ? ` — ${voider}` : ""}
            {expense.voided_at
              ? `, ${new Date(expense.voided_at).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}`
              : ""}
          </p>
          <p className="mt-2 text-sm text-neutral-500 dark:text-ink-muted">
            It no longer counts against profit. It stays here so the month can still be explained.
          </p>
        </div>
      ) : null}

      <dl className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-surface-line dark:bg-surface-card">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-4 border-b border-neutral-100 px-5 py-3 text-sm last:border-b-0 dark:border-surface-line"
          >
            <dt className="flex-shrink-0 text-neutral-500 dark:text-ink-muted">{row.label}</dt>
            <dd className="min-w-0 break-words text-right font-medium">{row.value}</dd>
          </div>
        ))}
      </dl>

      {expense.note ? (
        <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card">
          <h2 className="font-semibold">Note</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-600 dark:text-ink-muted">{expense.note}</p>
        </section>
      ) : null}

      {expense.status === "recorded" && canVoid ? (
        <div className="border-t border-neutral-200 pt-5 dark:border-surface-line">
          <p className="mb-3 text-sm text-neutral-500 dark:text-ink-muted">
            An expense cannot be edited — the amount and date are fixed once recorded, so the ledger can be trusted. To
            correct one, void it and record the right one.
          </p>
          <VoidExpenseForm action={voidExpense.bind(null, expense.id)} />
        </div>
      ) : null}
    </div>
  );
}