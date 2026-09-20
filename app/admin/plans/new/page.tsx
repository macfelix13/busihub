import Link from "next/link";
import { PlanForm } from "../plan-form";

export const metadata = { title: "New plan — Busihub Admin" };

export default function NewPlanPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/admin/plans" className="text-sm text-brand-700 hover:underline dark:text-brand-300">
          ← All plans
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">New plan</h1>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-surface-line dark:bg-surface-card">
        <PlanForm />
      </div>
    </div>
  );
}