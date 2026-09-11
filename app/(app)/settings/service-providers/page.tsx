import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertCircle, Scissors } from "lucide-react";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusToggleButton } from "@/app/(app)/products/status-toggle-button";
import { signServiceProviderPhotoUrls } from "@/lib/storage/service-provider-photos";
import { setServiceProviderStatus } from "./actions";

export const metadata = { title: "Service providers" };

interface ProviderRow {
  id: string;
  name: string;
  title: string | null;
  phone: string | null;
  photo_url: string | null;
  status: "active" | "archived";
  branches: { name: string } | null;
}

export default async function ServiceProvidersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const activeStatus = status === "archived" ? "archived" : "active";

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.USERS_MANAGE);

  // Cosmetic — the RLS policy on service_providers re-checks this
  // regardless; someone who cannot manage staff has no reason to be on a
  // page whose only actions are add/edit/archive.
  if (!canManage) {
    redirect("/settings/staff");
  }

  const { data: providers, error } = await supabase
    .from("service_providers")
    .select("id, name, title, phone, photo_url, status, branches(name)")
    .eq("status", activeStatus)
    .order("name", { ascending: true });

  if (error) {
    console.error("ServiceProvidersPage: service_providers query failed", error);
  }

  const rows = (providers ?? []) as unknown as ProviderRow[];
  const photoUrls = await signServiceProviderPhotoUrls(
    supabase,
    rows.map((r) => r.photo_url)
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Service providers</h1>
          <p className="text-neutral-500 dark:text-ink-muted">
            Barbers, nail techs, and other staff who render a service but don&rsquo;t sign in to Busihub — link them
            to a sale line at the till and track their own performance under Reports → Sales.
          </p>
        </div>
        <Link href="/settings/service-providers/new" className="flex-shrink-0">
          <Button>Add service provider</Button>
        </Link>
      </div>

      <SegmentedControl
        className="self-start"
        options={[
          { key: "active", label: "Active", active: activeStatus === "active", href: "/settings/service-providers" },
          {
            key: "archived",
            label: "Archived",
            active: activeStatus === "archived",
            href: { pathname: "/settings/service-providers", query: { status: "archived" } },
          },
        ]}
      />

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span>Couldn&apos;t load service providers. Please refresh the page.</span>
        </p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-neutral-200 px-4 py-14 text-center dark:border-surface-line">
          <Scissors className="h-8 w-8 text-neutral-400" aria-hidden="true" />
          <p className="font-medium">
            {activeStatus === "archived" ? "No archived service providers" : "No service providers yet"}
          </p>
          {activeStatus === "active" ? (
            <p className="max-w-sm text-sm text-neutral-500 dark:text-ink-muted">
              Add a barber, nail tech, or other staff member who renders a service — they&rsquo;ll show up in the
              till&rsquo;s &ldquo;who rendered this?&rdquo; picker for their branch.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-surface-line dark:bg-surface-card">
          <ul className="divide-y divide-neutral-100 dark:divide-surface-line">
            {rows.map((provider) => {
              const photoUrl = provider.photo_url ? photoUrls.get(provider.photo_url) : null;
              return (
                <li
                  key={provider.id}
                  className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-100 dark:bg-surface">
                      {photoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={photoUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <Scissors className="h-4 w-4 text-neutral-400" aria-hidden="true" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{provider.name}</span>
                        {provider.title ? <span className="text-sm text-neutral-500 dark:text-ink-muted">{provider.title}</span> : null}
                      </div>
                      <p className="truncate text-sm text-neutral-500 dark:text-ink-muted">
                        {provider.branches?.name ?? "Unknown branch"}
                        {provider.phone ? ` · ${provider.phone}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2 self-end sm:self-auto">
                    <Link href={`/settings/service-providers/${provider.id}/edit`}>
                      <Button variant="secondary">Edit</Button>
                    </Link>
                    <StatusToggleButton
                      action={setServiceProviderStatus.bind(
                        null,
                        provider.id,
                        provider.status === "active" ? "archived" : "active"
                      )}
                      label={provider.status === "active" ? "Archive" : "Restore"}
                      pendingLabel="Saving…"
                      variant={provider.status === "active" ? "danger" : "secondary"}
                      confirm={
                        provider.status === "active"
                          ? {
                              title: "Archive this service provider?",
                              description:
                                "Past sales that named them keep the record — they just won't be offered at the till anymore. You can restore them later.",
                              confirmLabel: "Archive",
                            }
                          : undefined
                      }
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}