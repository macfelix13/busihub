import Link from "next/link";
import { notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { suspendBusiness, reactivateBusiness } from "./actions";
import { StatusToggleButton } from "@/app/(app)/products/status-toggle-button";

export const metadata = { title: "Business — Busihub Admin" };

type BusinessStatus = "active" | "suspended" | "closed";

const STATUS_BADGE: Record<BusinessStatus, string> = {
  active: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  suspended: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  closed: "bg-neutral-100 text-neutral-600 dark:bg-surface dark:text-ink-muted",
};

interface StaffRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  status: string;
  last_login_at: string | null;
  created_at: string;
}

export default async function AdminBusinessDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();

  // Not scoped to the caller's own business_id — see app/admin/businesses/
  // page.tsx's comment. This page is reachable only through the /admin
  // layout's isSuperAdmin() gate, with RLS (0009) as the backstop under it.
  const { data: business, error } = await supabase
    .from("businesses")
    .select(
      "id, name, status, business_type, email, phone, address_line1, address_line2, city, region, country_code, currency_code, created_at, created_by"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("AdminBusinessDetailPage: business query failed", error);
  }

  if (!business) {
    notFound();
  }

  const [{ data: owner, error: ownerError }, { data: staffRows, error: staffError }] = await Promise.all([
    business.created_by
      ? supabase
          .from("profiles")
          .select("id, first_name, last_name, email, phone")
          .eq("id", business.created_by)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("profiles")
      .select("id, first_name, last_name, email, status, last_login_at, created_at")
      .eq("business_id", business.id)
      .order("created_at", { ascending: true }),
  ]);

  if (ownerError) console.error("AdminBusinessDetailPage: owner query failed", ownerError);
  if (staffError) console.error("AdminBusinessDetailPage: staff query failed", staffError);

  const staff = (staffRows ?? []) as StaffRow[];
  const status = business.status as BusinessStatus;

  const addressLines = [business.address_line1, business.address_line2, [business.city, business.region].filter(Boolean).join(", ")].filter(
    (part) => part && part.trim().length > 0
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/admin/businesses" className="text-sm text-brand-700 hover:underline dark:text-brand-300">
          ← All businesses
        </Link>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{business.name}</h1>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status]}`}>
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </span>
            </div>
            <p className="text-neutral-500 dark:text-ink-muted">
              {business.business_type || "No business type set"} · {business.country_code} · {business.currency_code}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {status === "active" ? (
              <StatusToggleButton
                action={suspendBusiness.bind(null, business.id)}
                label="Suspend"
                pendingLabel="Suspending…"
                variant="danger"
              />
            ) : (
              <StatusToggleButton
                action={reactivateBusiness.bind(null, business.id)}
                label="Reactivate"
                pendingLabel="Reactivating…"
                variant="secondary"
              />
            )}
          </div>
        </div>
      </div>

      {status !== "active" ? (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {status === "suspended"
            ? "This business is suspended — its staff cannot sign in to Busihub until it's reactivated."
            : "This business is closed."}
        </p>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-surface-line dark:bg-surface-card">
        <dl className="divide-y divide-neutral-100 dark:divide-surface-line">
          {[
            ["Registering owner", owner ? `${owner.first_name} ${owner.last_name}`.trim() : "Not on record"],
            ["Owner email", owner?.email ?? "—"],
            ["Owner phone", owner?.phone ?? "—"],
            ["Business email", business.email ?? "—"],
            ["Business phone", business.phone ?? "—"],
            ["Address", addressLines.length > 0 ? addressLines.join(", ") : "—"],
            [
              "Signed up",
              new Date(business.created_at).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "long",
                year: "numeric",
              }),
            ],
          ].map(([label, value]) => (
            <div key={label} className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
              <dt className="text-sm font-medium text-neutral-500 dark:text-ink-muted">{label}</dt>
              <dd className="min-w-0 break-words text-sm text-neutral-800 dark:text-ink sm:col-span-2">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div>
        <h2 className="font-semibold">Staff ({staff.length})</h2>
        <div className="mt-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-surface-line dark:bg-surface-card">
          <ul className="divide-y divide-neutral-100 dark:divide-surface-line">
            {staff.length > 0 ? (
              staff.map((person) => (
                <li
                  key={person.id}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-3.5 text-sm"
                >
                  <span className="min-w-0 break-words">
                    <span className="font-medium">{`${person.first_name} ${person.last_name}`.trim()}</span>
                    {person.email ? <span className="ml-2 text-neutral-500 dark:text-ink-muted">{person.email}</span> : null}
                    {person.status !== "active" ? (
                      <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-surface dark:text-ink-muted">
                        {person.status}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex-shrink-0 text-neutral-500 dark:text-ink-muted">
                    {person.last_login_at
                      ? `Last login ${new Date(person.last_login_at).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}`
                      : "Never logged in"}
                  </span>
                </li>
              ))
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500 dark:text-ink-muted">No staff on record.</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}