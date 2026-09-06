import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { categoryIconComponent } from "@/lib/ui/category-icons";
import { setCategoryStatus } from "./actions";
import { StatusToggleButton } from "../status-toggle-button";

export const metadata = { title: "Categories" };

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  is_system: boolean;
  status: "active" | "archived";
}

export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const activeStatus = status === "archived" ? "archived" : "active";

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canCreate, canEdit] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CREATE),
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_EDIT),
  ]);

  // Cosmetic — the RLS policy on categories re-checks this regardless;
  // someone who can neither create nor edit products has no reason to be
  // on a page whose only actions are add/rename/archive.
  if (!canCreate && !canEdit) {
    redirect("/products");
  }

  const { data: categories, error } = await supabase
    .from("categories")
    .select("id, name, description, icon, is_system, status")
    .eq("status", activeStatus)
    .order("name", { ascending: true });

  if (error) {
    console.error("CategoriesPage: categories query failed", error);
  }

  const rows = (categories ?? []) as CategoryRow[];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Categories</h1>
          <p className="text-neutral-500">Shared by products and services — used to group and filter your catalog.</p>
        </div>
        {canCreate ? (
          <Link href="/products/categories/new">
            <Button>Add category</Button>
          </Link>
        ) : null}
      </div>

      <div className="flex gap-1 self-start rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
        <Link
          href="/products/categories"
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
            activeStatus === "active" ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
          }`}
        >
          Active
        </Link>
        <Link
          href={{ pathname: "/products/categories", query: { status: "archived" } }}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
            activeStatus === "archived" ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
          }`}
        >
          Archived
        </Link>
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load categories. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {rows.length > 0 ? (
              rows.map((category) => {
                const Icon = categoryIconComponent(category.icon);
                return (
                  <li key={category.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-neutral-100 dark:bg-neutral-800">
                        {Icon ? <Icon className="h-4 w-4" aria-hidden="true" /> : null}
                      </span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{category.name}</span>
                          {category.is_system ? (
                            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                              Starter
                            </span>
                          ) : null}
                        </div>
                        {category.description ? (
                          <p className="text-sm text-neutral-500">{category.description}</p>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 self-end sm:self-auto">
                      {canEdit ? (
                        <Link href={`/products/categories/${category.id}/edit`}>
                          <Button variant="secondary">Edit</Button>
                        </Link>
                      ) : null}
                      {canEdit ? (
                        <StatusToggleButton
                          action={setCategoryStatus.bind(null, category.id, category.status === "active" ? "archived" : "active")}
                          label={category.status === "active" ? "Archive" : "Restore"}
                          pendingLabel="Saving…"
                          variant={category.status === "active" ? "danger" : "secondary"}
                          confirm={
                            category.status === "active"
                              ? {
                                  title: "Archive this category?",
                                  description:
                                    "Products and services already using it keep it — it just won't be offered for new ones. You can restore it later.",
                                  confirmLabel: "Archive",
                                }
                              : undefined
                          }
                        />
                      ) : null}
                    </div>
                  </li>
                );
              })
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500">
                {activeStatus === "archived" ? "No archived categories." : "No categories yet."}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}