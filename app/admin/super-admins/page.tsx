import { createServerSupabaseClient } from "@/lib/supabase/server";

export const metadata = { title: "Super Admins — Busihub Admin" };

interface SuperAdminRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  created_at: string;
}

interface GrantEventRow {
  resource_id: string | null;
  created_at: string;
}

/**
 * Read-only, by design (see this feature's write-up in the conversation
 * that shipped it, and docs/ARCHITECTURE.md's changelog entry): granting
 * or revoking profiles.is_super_admin stays a deliberate, by-hand step in
 * the Supabase SQL editor via bootstrap_super_admin() (0035), which is
 * explicitly revoked from `authenticated`/`anon` and documented as
 * "deliberately not usable by the application". This page only ever
 * SELECTs — it adds no new privilege, just visibility into one that
 * already existed and was previously only checkable with a direct SQL
 * query against production.
 */
export default async function AdminSuperAdminsPage() {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, email, created_at")
    .eq("is_super_admin", true)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("AdminSuperAdminsPage: profiles query failed", error);
  }

  const admins = (data ?? []) as SuperAdminRow[];

  // bootstrap_super_admin() (0035) logs a platform.super_admin_granted
  // event with resource_id = the profile just granted — the actual grant
  // date, which is a better answer to "since when" than profiles.created_at
  // (that's just when the account itself was made, possibly long before it
  // was ever elevated). Best-effort: falls back to created_at below if this
  // query fails or a grant predates this audit trail existing.
  const { data: grantRows, error: grantError } =
    admins.length > 0
      ? await supabase
          .from("audit_logs")
          .select("resource_id, created_at")
          .eq("action", "platform.super_admin_granted")
          .in(
            "resource_id",
            admins.map((a) => a.id)
          )
      : { data: [] as GrantEventRow[], error: null };

  if (grantError) {
    console.error("AdminSuperAdminsPage: grant audit log query failed", grantError);
  }

  const grantedAtById = new Map<string, string>();
  for (const row of (grantRows ?? []) as GrantEventRow[]) {
    if (!row.resource_id) continue;
    // A profile could in principle have more than one grant event
    // recorded (granted, revoked by hand, granted again) — earliest one
    // on file is what "since" should read as.
    const existing = grantedAtById.get(row.resource_id);
    if (!existing || row.created_at < existing) {
      grantedAtById.set(row.resource_id, row.created_at);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Super Admins</h1>
        <p className="text-neutral-500 dark:text-ink-muted">
          Everyone with platform-wide access, {admins.length} total.
        </p>
      </div>

      <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        This list is read-only. Granting or revoking Super Admin is a deliberate, by-hand step in the Supabase SQL
        editor (<code>select bootstrap_super_admin(&apos;&lt;user-id&gt;&apos;);</code>) — it can&apos;t be done from
        this console, on purpose, so that a bug or a compromised admin session can never mint another Super Admin
        through the app.
      </p>

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load Super Admins. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-surface-line dark:bg-surface-card">
          <ul className="divide-y divide-neutral-100 dark:divide-surface-line">
            {admins.length > 0 ? (
              admins.map((admin) => (
                <li key={admin.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-3.5 text-sm">
                  <span className="min-w-0 break-words">
                    <span className="font-medium">{`${admin.first_name} ${admin.last_name}`.trim()}</span>
                    {admin.email ? <span className="ml-2 text-neutral-500 dark:text-ink-muted">{admin.email}</span> : null}
                  </span>
                  <span className="flex-shrink-0 text-neutral-500 dark:text-ink-muted">
                    Since{" "}
                    {new Date(grantedAtById.get(admin.id) ?? admin.created_at).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                </li>
              ))
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500 dark:text-ink-muted">
                No Super Admins on record.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}