import { createServerSupabaseClient } from "@/lib/supabase/server";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Every query below is scoped by RLS to the caller's own business —
  // there is no explicit .eq("business_id", ...) anywhere here, and
  // there doesn't need to be (Section 4, Section 49).
  const [{ data: branches }, { data: roleAssignments }, { data: subscription }] = await Promise.all([
    supabase.from("branches").select("id, name, is_main, city, region"),
    supabase
      .from("user_branch_roles")
      .select("branch_id, roles (name)")
      .eq("user_id", user?.id ?? ""),
    supabase
      .from("business_subscriptions")
      .select("status, trial_ends_at, subscription_plans (name)")
      .maybeSingle(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Welcome back</h1>
        <p className="text-neutral-500">
          This is the foundation-phase dashboard — POS, inventory, and reporting land in later phases
          (see docs/ARCHITECTURE.md).
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-sm text-neutral-500">Branches</p>
          <p className="mt-1 text-2xl font-semibold">{branches?.length ?? 0}</p>
        </div>
        <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-sm text-neutral-500">Your role</p>
          <p className="mt-1 text-2xl font-semibold">
            {(roleAssignments?.[0] as unknown as { roles: { name: string } } | undefined)?.roles?.name ?? "—"}
          </p>
        </div>
        <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-sm text-neutral-500">Subscription</p>
          <p className="mt-1 text-2xl font-semibold capitalize">{subscription?.status ?? "—"}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="mb-3 font-semibold">Branches</h2>
        {branches && branches.length > 0 ? (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {branches.map((branch) => (
              <li key={branch.id} className="flex items-center justify-between py-2.5 text-sm">
                <span>
                  {branch.name} {branch.is_main ? <span className="text-neutral-400">(main)</span> : null}
                </span>
                <span className="text-neutral-500">
                  {[branch.city, branch.region].filter(Boolean).join(", ") || "—"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">No branches yet.</p>
        )}
      </div>
    </div>
  );
}
