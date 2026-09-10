import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertCircle, FolderOpen } from "lucide-react";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
      <PageHeader
        title="Categories"
        description="Shared by products and services — used to group and filter your catalog."
        actions={
          canCreate ? (
            <Link href="/products/categories/new">
              <Button>Add category</Button>
            </Link>
          ) : null
        }
      />

      <SegmentedControl
        className="self-start"
        options={[
          { key: "active", label: "Active", active: activeStatus === "active", href: "/products/categories" },
          {
            key: "archived",
            label: "Archived",
            active: activeStatus === "archived",
            href: { pathname: "/products/categories", query: { status: "archived" } },
          },
        ]}
      />

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span>Couldn&apos;t load categories. Please refresh the page.</span>
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title={activeStatus === "archived" ? "No archived categories" : "No categories yet"}
        />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {rows.map((category) => {
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
                        {category.is_system ? <Badge variant="neutral">Starter</Badge> : null}
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
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}