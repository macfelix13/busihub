import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { signServiceProviderPhotoUrl } from "@/lib/storage/service-provider-photos";
import { ProviderForm } from "../../provider-form";
import { updateServiceProvider } from "../../actions";

export const metadata = { title: "Edit service provider" };

export default async function EditServiceProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.USERS_MANAGE);

  // Cosmetic — updateServiceProvider() re-checks this server-side regardless.
  if (!canManage) {
    redirect("/settings/service-providers");
  }

  // RLS-scoped: a provider id from another tenant simply won't be found here.
  const [{ data: provider, error }, { data: branchRows, error: branchesError }] = await Promise.all([
    supabase.from("service_providers").select("id, name, title, phone, branch_id, photo_url").eq("id", id).maybeSingle(),
    supabase.from("branches").select("id, name").eq("status", "active").order("is_main", { ascending: false }).order("name"),
  ]);

  if (error) {
    console.error("EditServiceProviderPage: service_providers query failed", error);
  }
  if (branchesError) {
    console.error("EditServiceProviderPage: branches query failed", branchesError);
  }

  if (!provider) {
    notFound();
  }

  const branches = (branchRows ?? []) as { id: string; name: string }[];
  const photoUrl = await signServiceProviderPhotoUrl(supabase, provider.photo_url);

  const boundUpdateServiceProvider = updateServiceProvider.bind(null, provider.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Edit service provider</h1>
        <p className="text-neutral-500 dark:text-ink-muted">{provider.name}</p>
      </div>
      <ProviderForm
        action={boundUpdateServiceProvider}
        providerId={provider.id}
        branches={branches}
        defaultValues={{
          name: provider.name,
          title: provider.title ?? "",
          phone: provider.phone ?? "",
          branchId: provider.branch_id,
          photoUrl,
        }}
        submitLabel="Save changes"
      />
    </div>
  );
}