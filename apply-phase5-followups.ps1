# Busihub -- apply-phase5-followups.ps1
# Optional SKU (migration 0014), product category filter, explorable branches.
# Run this from the root of your busihub project (F:\busihub).
$ErrorActionPreference = 'Stop'

Write-Host "Writing app/(app)/branches/page.tsx"
New-Item -ItemType Directory -Force -Path "app/(app)/branches" | Out-Null
$content = @'
import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { SetMainBranchButton } from "./set-main-branch-button";

export const metadata = { title: "Branches" };

export default async function BranchesPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.BRANCHES_MANAGE);

  // RLS-scoped — no explicit .eq("business_id", ...) needed (Section 4, Section 49).
  const { data: branches, error } = await supabase
    .from("branches")
    .select("id, name, is_main, city, region, phone, email, status")
    .order("is_main", { ascending: false })
    .order("name", { ascending: true });

  if (error) {
    console.error("BranchesPage: branches query failed", error);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Branches</h1>
          <p className="text-neutral-500">Locations your business operates from.</p>
        </div>
        {canManage ? (
          <Link href="/branches/new">
            <Button>Add branch</Button>
          </Link>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load branches. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {branches && branches.length > 0 ? (
              branches.map((branch) => (
                <li key={branch.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <Link href={`/branches/${branch.id}`} className="flex-1 rounded-lg hover:opacity-80">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{branch.name}</span>
                      {branch.is_main ? (
                        <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-800 dark:bg-brand-900 dark:text-brand-200">
                          Main
                        </span>
                      ) : null}
                      {branch.status === "inactive" ? (
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                          Inactive
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-sm text-neutral-500">
                      {[branch.city, branch.region].filter(Boolean).join(", ") || "No location set"}
                      {branch.phone ? ` · ${branch.phone}` : ""}
                    </p>
                  </Link>
                  {canManage ? (
                    <div className="flex items-center gap-2">
                      {!branch.is_main ? <SetMainBranchButton branchId={branch.id} /> : null}
                      <Link href={`/branches/${branch.id}/edit`}>
                        <Button variant="secondary">Edit</Button>
                      </Link>
                    </div>
                  ) : null}
                </li>
              ))
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500">No branches yet.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

'@
Set-Content -LiteralPath "app/(app)/branches/page.tsx" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing app/(app)/branches/[id]/page.tsx"
New-Item -ItemType Directory -Force -Path "app/(app)/branches/[id]" | Out-Null
$content = @'
import Link from "next/link";
import { notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { SetMainBranchButton } from "../set-main-branch-button";

export const metadata = { title: "Branch" };

function addressLabel(branch: {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
}): string {
  const lines = [branch.address_line1, branch.address_line2, [branch.city, branch.region].filter(Boolean).join(", ")].filter(
    (part) => part && part.trim().length > 0
  );
  return lines.length > 0 ? lines.join(", ") : "No address set";
}

export default async function BranchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canManage = await hasPermission(supabase, businessId, PERMISSIONS.BRANCHES_MANAGE);

  // RLS-scoped: a branch id from another tenant simply won't be found here.
  const { data: branch, error } = await supabase
    .from("branches")
    .select("id, name, is_main, address_line1, address_line2, city, region, phone, email, timezone, status")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("BranchDetailPage: branch query failed", error);
  }

  if (!branch) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{branch.name}</h1>
            {branch.is_main ? (
              <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-800 dark:bg-brand-900 dark:text-brand-200">
                Main
              </span>
            ) : null}
            {branch.status === "inactive" ? (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                Inactive
              </span>
            ) : null}
          </div>
          <p className="text-neutral-500">{addressLabel(branch)}</p>
        </div>
        <div className="flex items-center gap-2">
          {canManage ? (
            <Link href={`/branches/${branch.id}/edit`}>
              <Button variant="secondary">Edit</Button>
            </Link>
          ) : null}
          {canManage && !branch.is_main ? <SetMainBranchButton branchId={branch.id} /> : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <dl className="divide-y divide-neutral-100 dark:divide-neutral-800">
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">Phone</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">{branch.phone || "—"}</dd>
          </div>
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">Email</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">{branch.email || "—"}</dd>
          </div>
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">Address</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">
              {branch.address_line1 || "—"}
              {branch.address_line2 ? `, ${branch.address_line2}` : ""}
            </dd>
          </div>
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">City / Region</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">
              {[branch.city, branch.region].filter(Boolean).join(", ") || "—"}
            </dd>
          </div>
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">Timezone</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">{branch.timezone}</dd>
          </div>
          <div className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-neutral-500">Status</dt>
            <dd className="text-sm text-neutral-800 dark:text-neutral-200 sm:col-span-2">
              {branch.status === "active" ? "Active" : "Inactive"}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

'@
Set-Content -LiteralPath "app/(app)/branches/[id]/page.tsx" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing app/(app)/products/[id]/page.tsx"
New-Item -ItemType Directory -Force -Path "app/(app)/products/[id]" | Out-Null
$content = @'
import Link from "next/link";
import { notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money/money";
import { setProductStatus, setVariantStatus } from "../actions";
import { StatusToggleButton } from "../status-toggle-button";

export const metadata = { title: "Product" };

function optionsLabel(options: Record<string, string>): string {
  const entries = Object.entries(options);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}: ${value}`).join(", ");
}

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const [canEdit, canArchive, canChangePrice, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_EDIT),
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_ARCHIVE),
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CHANGE_PRICE),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
  ]);
  const currencyCode = business?.currency_code ?? "GHS";

  // RLS-scoped: a product id from another tenant simply won't be found here.
  const { data: product, error } = await supabase
    .from("products")
    .select(
      "id, name, description, category, unit_of_measure, tax_category, has_variants, variant_option_names, status, product_variants(id, sku, barcode, variant_options, cost_price, selling_price, is_default, status)"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("ProductDetailPage: product query failed", error);
  }

  if (!product) {
    notFound();
  }

  // sku is optional (0014) — a.sku.localeCompare would throw on null, so
  // variants without one sort after every variant that has one, and
  // amongst themselves by nothing in particular (insertion order).
  const variants = [...product.product_variants].sort((a, b) => {
    if (a.sku === null && b.sku === null) return 0;
    if (a.sku === null) return 1;
    if (b.sku === null) return -1;
    return a.sku.localeCompare(b.sku);
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{product.name}</h1>
            {product.status === "archived" ? (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                Archived
              </span>
            ) : null}
          </div>
          <p className="text-neutral-500">
            {product.category || "Uncategorized"} · {product.unit_of_measure}
          </p>
          {product.description ? <p className="mt-2 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">{product.description}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          {canEdit ? (
            <Link href={`/products/${product.id}/edit`}>
              <Button variant="secondary">Edit</Button>
            </Link>
          ) : null}
          {canArchive ? (
            <StatusToggleButton
              action={setProductStatus.bind(null, product.id, product.status === "active" ? "archived" : "active")}
              label={product.status === "active" ? "Archive product" : "Restore product"}
              pendingLabel="Saving…"
              variant={product.status === "active" ? "danger" : "secondary"}
            />
          ) : null}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Variants</h2>
          {canEdit && product.has_variants ? (
            <Link href={`/products/${product.id}/variants/new`}>
              <Button variant="secondary">Add variant</Button>
            </Link>
          ) : null}
        </div>

        <div className="mt-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase text-neutral-500 dark:border-neutral-800">
                <tr>
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">Barcode</th>
                  {product.has_variants ? <th className="px-4 py-3 font-medium">Options</th> : null}
                  <th className="px-4 py-3 font-medium">Cost</th>
                  <th className="px-4 py-3 font-medium">Price</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {variants.map((variant) => (
                  <tr key={variant.id}>
                    <td className="px-4 py-3 font-medium">{variant.sku || "—"}</td>
                    <td className="px-4 py-3 text-neutral-500">{variant.barcode || "—"}</td>
                    {product.has_variants ? (
                      <td className="px-4 py-3 text-neutral-500">{optionsLabel(variant.variant_options as Record<string, string>)}</td>
                    ) : null}
                    <td className="px-4 py-3">{formatMoneyMinor(variant.cost_price, currencyCode)}</td>
                    <td className="px-4 py-3">{formatMoneyMinor(variant.selling_price, currencyCode)}</td>
                    <td className="px-4 py-3">
                      {variant.status === "archived" ? (
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                          Archived
                        </span>
                      ) : (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
                          Active
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {canEdit ? (
                          <Link href={`/products/${product.id}/variants/${variant.id}/edit`}>
                            <Button variant="ghost">Edit</Button>
                          </Link>
                        ) : null}
                        {canArchive ? (
                          <StatusToggleButton
                            action={setVariantStatus.bind(null, product.id, variant.id, variant.status === "active" ? "archived" : "active")}
                            label={variant.status === "active" ? "Archive" : "Restore"}
                            pendingLabel="Saving…"
                            variant="ghost"
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {!canChangePrice ? (
          <p className="mt-2 text-sm text-neutral-500">You can view prices here but don&apos;t have permission to change them.</p>
        ) : null}
      </div>
    </div>
  );
}

/** product_variants.cost_price/selling_price come back from Postgres as decimal strings via PostgREST, not JS numbers — coerce before formatting. */
function formatMoneyMinor(decimalAmount: number | string, currencyCode: string): string {
  const amount = typeof decimalAmount === "string" ? Number(decimalAmount) : decimalAmount;
  return formatMoney(Math.round(amount * 100), currencyCode);
}

'@
Set-Content -LiteralPath "app/(app)/products/[id]/page.tsx" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing app/(app)/products/[id]/variants/[variantId]/edit/page.tsx"
New-Item -ItemType Directory -Force -Path "app/(app)/products/[id]/variants/[variantId]/edit" | Out-Null
$content = @'
import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { VariantForm } from "../../../../variant-form";
import { updateVariant } from "../../../../actions";

export const metadata = { title: "Edit variant" };

export default async function EditVariantPage({ params }: { params: Promise<{ id: string; variantId: string }> }) {
  const { id, variantId } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const [canEdit, canChangePrice] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_EDIT),
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CHANGE_PRICE),
  ]);

  // Cosmetic — updateVariant() re-checks products.edit server-side
  // regardless, and separately re-checks products.change_price before
  // ever including a price field in the update (Section 49).
  if (!canEdit) {
    redirect(`/products/${id}`);
  }

  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id, name, variant_option_names")
    .eq("id", id)
    .maybeSingle();

  if (productError || !product) {
    console.error("EditVariantPage: product query failed", productError);
    notFound();
  }

  const { data: variant, error: variantError } = await supabase
    .from("product_variants")
    .select("id, sku, barcode, variant_options, cost_price, selling_price")
    .eq("id", variantId)
    .eq("product_id", id)
    .maybeSingle();

  if (variantError) {
    console.error("EditVariantPage: variant query failed", variantError);
  }

  if (!variant) {
    notFound();
  }

  const boundUpdateVariant = updateVariant.bind(null, product.id, variant.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Edit variant</h1>
        <p className="text-neutral-500">
          {product.name} · {variant.sku || "no SKU"}
        </p>
      </div>
      <VariantForm
        action={boundUpdateVariant}
        optionNames={product.variant_option_names as string[]}
        canSetPrice={canChangePrice}
        defaultValues={{
          sku: variant.sku ?? "",
          barcode: variant.barcode ?? "",
          variantOptions: variant.variant_options as Record<string, string>,
          costPrice: Number(variant.cost_price),
          sellingPrice: Number(variant.selling_price),
        }}
        submitLabel="Save changes"
        pendingLabel="Saving…"
      />
    </div>
  );
}

'@
Set-Content -LiteralPath "app/(app)/products/[id]/variants/[variantId]/edit/page.tsx" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing app/(app)/products/actions.ts"
New-Item -ItemType Directory -Force -Path "app/(app)/products" | Out-Null
$content = @'
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, hasPermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import {
  createProductSchema,
  productDetailsSchema,
  variantFormSchema,
  type VariantRowInput,
} from "@/lib/validation/products";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

type SupabaseServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

async function requireProductPermission(supabase: SupabaseServerClient, permission: PermissionKey) {
  const businessId = await getCurrentBusinessId(supabase);
  await requirePermission(supabase, businessId, permission);
  return businessId;
}

function jsonField<T>(formData: FormData, name: string, fallback: T): T {
  const raw = formData.get(name);
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function createProductFormValues(formData: FormData) {
  return {
    name: formData.get("name"),
    description: formData.get("description"),
    category: formData.get("category"),
    unitOfMeasure: formData.get("unitOfMeasure"),
    taxCategory: formData.get("taxCategory"),
    variantOptionNames: jsonField<string[]>(formData, "variantOptionNamesJson", []),
    variants: jsonField<unknown[]>(formData, "variantsJson", []),
  };
}

/**
 * Maps a Postgres unique_violation (23505) to the form field it
 * corresponds to, so the user sees "this SKU is taken" instead of a raw
 * DB error. Only called once the caller has confirmed error.code ===
 * "23505" — the constraint name is matched from error.message (which
 * PostgREST/postgrest-js pass through from Postgres's own error text;
 * confirmed against a real Postgres instance — see
 * supabase/migrations/0013's tests — though the exact message text is
 * only PostgREST-verified once this runs against a real Supabase
 * project).
 */
function duplicateFieldFromError(message: string): { field: string; text: string } | null {
  if (message.includes("products_business_id_name_key")) {
    return { field: "name", text: "A product with this name already exists." };
  }
  if (message.includes("product_variants_business_id_sku_key")) {
    return { field: "sku", text: "This SKU is already used by another product." };
  }
  if (message.includes("product_variants_business_barcode_idx")) {
    return { field: "barcode", text: "This barcode is already used by another product." };
  }
  return null;
}

export async function createProduct(_prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = createProductSchema.safeParse(createProductFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireProductPermission(supabase, PERMISSIONS.PRODUCTS_CREATE);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("createProduct: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { name, description, category, unitOfMeasure, taxCategory, variantOptionNames, variants } = parsed.data;

  const { error } = await supabase.rpc("create_product", {
    p_business_id: businessId,
    p_name: name,
    p_description: description || null,
    p_category: category || null,
    p_unit_of_measure: unitOfMeasure,
    p_tax_category: taxCategory,
    p_variant_option_names: variantOptionNames,
    p_variants: variants.map((v: VariantRowInput) => ({
      sku: v.sku || null,
      barcode: v.barcode || null,
      variant_options: v.variantOptions,
      cost_price: v.costPrice,
      selling_price: v.sellingPrice,
    })),
  });

  if (error) {
    console.error("createProduct: rpc failed", error);
    const dup = error.code === "23505" ? duplicateFieldFromError(error.message ?? "") : null;
    if (dup) {
      return { error: dup.text, fieldErrors: { [dup.field]: dup.text } };
    }
    return { error: "Couldn't create the product. Please try again." };
  }

  revalidatePath("/products");
  redirect("/products");
}

export async function updateProductDetails(productId: string, _prevState: FormState, formData: FormData): Promise<FormState> {
  const parsed = productDetailsSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
    category: formData.get("category"),
    unitOfMeasure: formData.get("unitOfMeasure"),
    taxCategory: formData.get("taxCategory"),
  });

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireProductPermission(supabase, PERMISSIONS.PRODUCTS_EDIT);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("updateProductDetails: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { name, description, category, unitOfMeasure, taxCategory } = parsed.data;

  const { error } = await supabase
    .from("products")
    .update({
      name,
      description: description || null,
      category: category || null,
      unit_of_measure: unitOfMeasure,
      tax_category: taxCategory,
    })
    // business_id filter is belt-and-suspenders beyond RLS (Section 49) —
    // a wrong/forged productId for another tenant affects 0 rows.
    .eq("id", productId)
    .eq("business_id", businessId);

  if (error) {
    console.error("updateProductDetails: update failed", error);
    const dup = error.code === "23505" ? duplicateFieldFromError(error.message ?? "") : null;
    if (dup) return { error: dup.text, fieldErrors: { [dup.field]: dup.text } };
    return { error: "Couldn't save changes. Please try again." };
  }

  revalidatePath("/products");
  revalidatePath(`/products/${productId}`);
  redirect(`/products/${productId}`);
}

/**
 * Plain (no useFormState) action bound to a product id and target status,
 * same pattern as branches/actions.ts's setMainBranch — the triggering
 * button is only ever rendered for a caller who already has
 * products.archive (cosmetic check), so a thrown error here means
 * permissions changed out from under them mid-session, not the expected
 * path.
 */
export async function setProductStatus(productId: string, status: "active" | "archived"): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const businessId = await requireProductPermission(supabase, PERMISSIONS.PRODUCTS_ARCHIVE);

  const { error } = await supabase.from("products").update({ status }).eq("id", productId).eq("business_id", businessId);

  if (error) {
    console.error("setProductStatus: update failed", error);
    throw new Error("Couldn't update the product's status. Please try again.");
  }

  revalidatePath("/products");
  revalidatePath(`/products/${productId}`);
}

export async function setVariantStatus(productId: string, variantId: string, status: "active" | "archived"): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const businessId = await requireProductPermission(supabase, PERMISSIONS.PRODUCTS_ARCHIVE);

  const { error } = await supabase
    .from("product_variants")
    .update({ status })
    .eq("id", variantId)
    .eq("product_id", productId)
    .eq("business_id", businessId);

  if (error) {
    console.error("setVariantStatus: update failed", error);
    throw new Error("Couldn't update the variant's status. Please try again.");
  }

  revalidatePath(`/products/${productId}`);
}

function variantFormValues(formData: FormData) {
  return {
    sku: formData.get("sku"),
    barcode: formData.get("barcode"),
    variantOptions: jsonField<Record<string, string>>(formData, "variantOptionsJson", {}),
    costPrice: formData.get("costPrice"),
    sellingPrice: formData.get("sellingPrice"),
  };
}

export async function addVariant(productId: string, _prevState: FormState, formData: FormData): Promise<FormState> {
  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    // Adding a variant to an EXISTING product is gated by products.edit,
    // not products.create — see the migration's file header for why.
    businessId = await requireProductPermission(supabase, PERMISSIONS.PRODUCTS_EDIT);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("addVariant: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id, has_variants, variant_option_names")
    .eq("id", productId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (productError || !product) {
    console.error("addVariant: product lookup failed", productError);
    return { error: "Couldn't find this product." };
  }

  if (!product.has_variants) {
    // This phase doesn't support turning a simple product into a
    // variant one after the fact — see the migration's file header.
    return { error: "This product doesn't use variants — edit it directly instead of adding a variant." };
  }

  const parsed = variantFormSchema(product.variant_option_names as string[]).safeParse(variantFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const { sku, barcode, variantOptions, costPrice, sellingPrice } = parsed.data;

  const { error } = await supabase.from("product_variants").insert({
    product_id: productId,
    sku: sku || null,
    barcode: barcode || null,
    variant_options: variantOptions,
    cost_price: costPrice,
    selling_price: sellingPrice,
    is_default: false,
  });

  if (error) {
    console.error("addVariant: insert failed", error);
    const dup = error.code === "23505" ? duplicateFieldFromError(error.message ?? "") : null;
    if (dup) return { error: dup.text, fieldErrors: { [dup.field]: dup.text } };
    return { error: "Couldn't add this variant. Please try again." };
  }

  revalidatePath(`/products/${productId}`);
  redirect(`/products/${productId}`);
}

export async function updateVariant(productId: string, variantId: string, _prevState: FormState, formData: FormData): Promise<FormState> {
  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await requireProductPermission(supabase, PERMISSIONS.PRODUCTS_EDIT);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("updateVariant: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id, variant_option_names")
    .eq("id", productId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (productError || !product) {
    console.error("updateVariant: product lookup failed", productError);
    return { error: "Couldn't find this product." };
  }

  const parsed = variantFormSchema(product.variant_option_names as string[]).safeParse(variantFormValues(formData));

  if (!parsed.success) {
    return { error: "Please fix the errors below.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  const { sku, barcode, variantOptions, costPrice, sellingPrice } = parsed.data;

  // products.edit covers sku/barcode/variantOptions. Changing the price of
  // a variant that's already on record needs products.change_price on top
  // of that — checked here (not just hidden in the UI) so a crafted
  // request from someone lacking it can't sneak a new price through; we
  // simply never include the price columns in the update for them, rather
  // than trusting whatever the form posted.
  const canChangePrice = await hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CHANGE_PRICE);

  const update: Record<string, unknown> = {
    sku: sku || null,
    barcode: barcode || null,
    variant_options: variantOptions,
  };
  if (canChangePrice) {
    update.cost_price = costPrice;
    update.selling_price = sellingPrice;
  }

  const { error } = await supabase
    .from("product_variants")
    .update(update)
    .eq("id", variantId)
    .eq("product_id", productId)
    .eq("business_id", businessId);

  if (error) {
    console.error("updateVariant: update failed", error);
    const dup = error.code === "23505" ? duplicateFieldFromError(error.message ?? "") : null;
    if (dup) return { error: dup.text, fieldErrors: { [dup.field]: dup.text } };
    return { error: "Couldn't save changes. Please try again." };
  }

  revalidatePath(`/products/${productId}`);
  redirect(`/products/${productId}`);
}

'@
Set-Content -LiteralPath "app/(app)/products/actions.ts" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing app/(app)/products/page.tsx"
New-Item -ItemType Directory -Force -Path "app/(app)/products" | Out-Null
$content = @'
import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { Button } from "@/components/ui/button";
import { formatMoney, toMinorUnits } from "@/lib/money/money";

export const metadata = { title: "Products" };

interface ProductRow {
  id: string;
  name: string;
  category: string | null;
  status: "active" | "archived";
  has_variants: boolean;
  // numeric(14,2) comes back from PostgREST as a string, not a number —
  // see the comment on lib/money/money.ts's toNumber().
  product_variants: { selling_price: number | string }[];
}

function priceRangeLabel(variants: { selling_price: number | string }[], currencyCode: string): string {
  if (variants.length === 0) return "No price set";
  const amounts = variants.map((v) => toMinorUnits(v.selling_price));
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  if (min === max) return formatMoney(min, currencyCode);
  return `${formatMoney(min, currencyCode)} – ${formatMoney(max, currencyCode)}`;
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; category?: string }>;
}) {
  const { q, status, category } = await searchParams;
  const activeStatus = status === "archived" ? "archived" : "active";
  const activeCategory = category && category.trim().length > 0 ? category.trim() : null;

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const [canCreate, { data: business }, { data: categoryRows, error: categoriesError }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CREATE),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
    // Distinct categories currently in use, to populate the filter — no
    // schema change (category stays free text, per this phase's scope),
    // just deduped/sorted client-side since PostgREST has no DISTINCT.
    supabase.from("products").select("category").not("category", "is", null),
  ]);
  const currencyCode = business?.currency_code ?? "GHS";

  if (categoriesError) {
    console.error("ProductsPage: categories query failed", categoriesError);
  }

  const categories = Array.from(
    new Set((categoryRows ?? []).map((r) => (r as { category: string }).category).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  // RLS-scoped — no explicit .eq("business_id", ...) needed (Section 4, Section 49).
  let query = supabase
    .from("products")
    .select("id, name, category, status, has_variants, product_variants(selling_price)")
    .eq("status", activeStatus)
    .order("name", { ascending: true });

  if (q && q.trim().length > 0) {
    query = query.ilike("name", `%${q.trim()}%`);
  }

  if (activeCategory) {
    query = query.eq("category", activeCategory);
  }

  const { data: products, error } = await query;

  if (error) {
    console.error("ProductsPage: products query failed", error);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Products</h1>
          <p className="text-neutral-500">Your catalog of sellable items.</p>
        </div>
        {canCreate ? (
          <Link href="/products/new">
            <Button>Add product</Button>
          </Link>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1 rounded-xl border border-neutral-200 p-1 dark:border-neutral-800">
          <Link
            href={{ pathname: "/products", query: { ...(q ? { q } : {}), ...(activeCategory ? { category: activeCategory } : {}) } }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              activeStatus === "active" ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            Active
          </Link>
          <Link
            href={{
              pathname: "/products",
              query: { status: "archived", ...(q ? { q } : {}), ...(activeCategory ? { category: activeCategory } : {}) },
            }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              activeStatus === "archived" ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            Archived
          </Link>
        </div>
        <form className="flex flex-wrap gap-2" action="/products">
          {activeStatus === "archived" ? <input type="hidden" name="status" value="archived" /> : null}
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by name…"
            className="min-h-[44px] w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white sm:w-56"
          />
          <select
            name="category"
            defaultValue={activeCategory ?? ""}
            className="min-h-[44px] rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load products. Please refresh the page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {products && products.length > 0 ? (
              (products as ProductRow[]).map((product) => (
                <li key={product.id}>
                  <Link
                    href={`/products/${product.id}`}
                    className="flex flex-col gap-1 px-5 py-4 hover:bg-neutral-50 sm:flex-row sm:items-center sm:justify-between dark:hover:bg-neutral-800/50"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{product.name}</span>
                        {product.has_variants ? (
                          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                            {product.product_variants.length} variants
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-sm text-neutral-500">{product.category || "Uncategorized"}</p>
                    </div>
                    <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                      {priceRangeLabel(product.product_variants, currencyCode)}
                    </p>
                  </Link>
                </li>
              ))
            ) : (
              <li className="px-5 py-8 text-center text-sm text-neutral-500">
                {activeStatus === "archived" ? "No archived products." : "No products yet."}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

'@
Set-Content -LiteralPath "app/(app)/products/page.tsx" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing app/(app)/products/product-form.tsx"
New-Item -ItemType Directory -Force -Path "app/(app)/products" | Out-Null
$content = @'
"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button, SubmitButton } from "@/components/ui/button";
import { UNITS_OF_MEASURE, TAX_CATEGORIES } from "@/lib/validation/products";
import { createProduct, type FormState } from "./actions";

const initialState: FormState = {};
const UNIT_OPTIONS = UNITS_OF_MEASURE.map((u) => ({ value: u.value, label: u.label }));
const TAX_OPTIONS = TAX_CATEGORIES.map((c) => ({ value: c.value, label: c.label }));

interface VariantRow {
  sku: string;
  barcode: string;
  variantOptions: Record<string, string>;
  costPrice: string;
  sellingPrice: string;
}

function emptyVariant(optionNames: string[]): VariantRow {
  return {
    sku: "",
    barcode: "",
    variantOptions: Object.fromEntries(optionNames.map((n) => [n, ""])),
    costPrice: "0",
    sellingPrice: "",
  };
}

/** Create-product form: base details + an optional variant-axis definition + one row per starting SKU. Every product needs at least one variant even if "This product comes in variants" stays unchecked — that single row becomes the product's sole (is_default) variant server-side. */
export function ProductForm() {
  const [state, formAction] = useFormState(createProduct, initialState);

  const [hasVariants, setHasVariants] = useState(false);
  const [optionNamesText, setOptionNamesText] = useState("");
  const optionNames = optionNamesText
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 3);

  const [variants, setVariants] = useState<VariantRow[]>([emptyVariant([])]);

  function patchVariant(index: number, patch: Partial<VariantRow>) {
    setVariants((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function patchVariantOption(index: number, optionName: string, value: string) {
    setVariants((rows) =>
      rows.map((row, i) => (i === index ? { ...row, variantOptions: { ...row.variantOptions, [optionName]: value } } : row))
    );
  }

  function addRow() {
    setVariants((rows) => [...rows, emptyVariant(optionNames)]);
  }

  function removeRow(index: number) {
    setVariants((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== index) : rows));
  }

  const effectiveVariants = hasVariants ? variants : [variants[0] ?? emptyVariant([])];
  const effectiveOptionNames = hasVariants ? optionNames : [];

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-col gap-4">
        <Field label="Product name" name="name" required error={state.fieldErrors?.name} />
        <Textarea label="Description (optional)" name="description" error={state.fieldErrors?.description} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Category (optional)" name="category" error={state.fieldErrors?.category} />
          <Select label="Unit of measure" name="unitOfMeasure" defaultValue="each" error={state.fieldErrors?.unitOfMeasure} options={UNIT_OPTIONS} />
          <Select label="Tax category" name="taxCategory" defaultValue="standard" error={state.fieldErrors?.taxCategory} options={TAX_OPTIONS} />
        </div>
      </div>

      <div className="border-t border-neutral-200 pt-5 dark:border-neutral-800">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={hasVariants}
            onChange={(e) => {
              const checked = e.target.checked;
              setHasVariants(checked);
              if (!checked) {
                setVariants((rows) => [{ ...(rows[0] ?? emptyVariant([])), variantOptions: {} }]);
              }
            }}
            className="h-5 w-5 rounded border-neutral-300 text-brand-600 focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            This product comes in variants (e.g. different sizes or colors)
          </span>
        </label>

        {hasVariants ? (
          <div className="mt-4 max-w-md">
            <Field
              label="Variant options (comma-separated, up to 3 — e.g. Size, Color)"
              value={optionNamesText}
              onChange={(e) => setOptionNamesText(e.target.value)}
            />
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-4">
        <h3 className="font-semibold">{hasVariants ? "Variants" : "Pricing"}</h3>

        {hasVariants && effectiveOptionNames.length === 0 ? (
          <p className="text-sm text-neutral-500">Enter at least one variant option above to start adding variants.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {effectiveVariants.map((row, index) => (
              <div key={index} className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
                {hasVariants && effectiveOptionNames.length > 0 ? (
                  <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {effectiveOptionNames.map((name) => (
                      <Field
                        key={name}
                        label={name}
                        value={row.variantOptions[name] ?? ""}
                        onChange={(e) => patchVariantOption(index, name, e.target.value)}
                        error={state.fieldErrors?.[`variants.${index}.variantOptions`]}
                      />
                    ))}
                  </div>
                ) : null}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <Field
                    label="SKU (optional)"
                    value={row.sku}
                    onChange={(e) => patchVariant(index, { sku: e.target.value })}
                    error={state.fieldErrors?.[`variants.${index}.sku`]}
                  />
                  <Field
                    label="Barcode (optional)"
                    value={row.barcode}
                    onChange={(e) => patchVariant(index, { barcode: e.target.value })}
                    error={state.fieldErrors?.[`variants.${index}.barcode`]}
                  />
                  <Field
                    label="Cost price"
                    type="number"
                    step="0.01"
                    min={0}
                    value={row.costPrice}
                    onChange={(e) => patchVariant(index, { costPrice: e.target.value })}
                    error={state.fieldErrors?.[`variants.${index}.costPrice`]}
                  />
                  <Field
                    label="Selling price"
                    type="number"
                    step="0.01"
                    min={0}
                    value={row.sellingPrice}
                    onChange={(e) => patchVariant(index, { sellingPrice: e.target.value })}
                    error={state.fieldErrors?.[`variants.${index}.sellingPrice`]}
                  />
                </div>
                {hasVariants && effectiveVariants.length > 1 ? (
                  <Button type="button" variant="ghost" className="mt-3" onClick={() => removeRow(index)}>
                    Remove this variant
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {hasVariants && effectiveOptionNames.length > 0 ? (
          <Button type="button" variant="secondary" className="self-start" onClick={addRow}>
            + Add variant
          </Button>
        ) : null}
      </div>

      {state.fieldErrors?.variants ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.fieldErrors.variants}
        </p>
      ) : null}

      <input type="hidden" name="variantOptionNamesJson" value={JSON.stringify(effectiveOptionNames)} />
      <input
        type="hidden"
        name="variantsJson"
        value={JSON.stringify(
          effectiveVariants.map((row) => ({
            sku: row.sku,
            barcode: row.barcode,
            variantOptions: hasVariants ? row.variantOptions : {},
            costPrice: row.costPrice,
            sellingPrice: row.sellingPrice,
          }))
        )}
      />

      <SubmitButton pendingText="Creating…" className="self-start px-6">
        Create product
      </SubmitButton>
    </form>
  );
}

'@
Set-Content -LiteralPath "app/(app)/products/product-form.tsx" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing app/(app)/products/variant-form.tsx"
New-Item -ItemType Directory -Force -Path "app/(app)/products" | Out-Null
$content = @'
"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/button";
import type { FormState } from "./actions";

const initialState: FormState = {};

interface VariantFormProps {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  optionNames: string[];
  defaultValues?: {
    sku?: string;
    barcode?: string;
    variantOptions?: Record<string, string>;
    costPrice?: number;
    sellingPrice?: number;
  };
  /**
   * Whether the caller may set/see the price fields on this submission.
   * true for "add a new variant" (products.edit is enough — see
   * supabase/migrations/0013's file header) and for "edit an existing
   * variant" only when the caller also has products.change_price. When
   * false, the price fields are shown read-only rather than omitted
   * entirely, so the user can still see what the price is.
   */
  canSetPrice: boolean;
  submitLabel: string;
  pendingLabel: string;
}

/** Shared by app/(app)/products/[id]/variants/new and .../[variantId]/edit. */
export function VariantForm({ action, optionNames, defaultValues, canSetPrice, submitLabel, pendingLabel }: VariantFormProps) {
  const [state, formAction] = useFormState(action, initialState);
  const [variantOptions, setVariantOptions] = useState<Record<string, string>>(() =>
    Object.fromEntries(optionNames.map((n) => [n, defaultValues?.variantOptions?.[n] ?? ""]))
  );

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      {optionNames.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {optionNames.map((name) => (
            <Field
              key={name}
              label={name}
              value={variantOptions[name] ?? ""}
              onChange={(e) => setVariantOptions((prev) => ({ ...prev, [name]: e.target.value }))}
              error={state.fieldErrors?.variantOptions}
            />
          ))}
        </div>
      ) : null}
      <input type="hidden" name="variantOptionsJson" value={JSON.stringify(variantOptions)} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="SKU (optional)" name="sku" defaultValue={defaultValues?.sku} error={state.fieldErrors?.sku} />
        <Field label="Barcode (optional)" name="barcode" defaultValue={defaultValues?.barcode} error={state.fieldErrors?.barcode} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {canSetPrice ? (
          <>
            <Field
              label="Cost price"
              name="costPrice"
              type="number"
              step="0.01"
              min={0}
              defaultValue={defaultValues?.costPrice ?? 0}
              error={state.fieldErrors?.costPrice}
            />
            <Field
              label="Selling price"
              name="sellingPrice"
              type="number"
              step="0.01"
              min={0}
              defaultValue={defaultValues?.sellingPrice}
              error={state.fieldErrors?.sellingPrice}
            />
          </>
        ) : (
          <>
            {/* Not permitted to set price (products.change_price) on an existing variant — still submit the current values unchanged rather than omitting them, and show them read-only for context. */}
            <input type="hidden" name="costPrice" value={defaultValues?.costPrice ?? 0} />
            <input type="hidden" name="sellingPrice" value={defaultValues?.sellingPrice ?? 0} />
            <p className="text-sm text-neutral-500 sm:col-span-2">
              Cost price GH₵{(defaultValues?.costPrice ?? 0).toFixed(2)} · Selling price GH₵{(defaultValues?.sellingPrice ?? 0).toFixed(2)}
              — you don&apos;t have permission to change prices.
            </p>
          </>
        )}
      </div>

      <SubmitButton pendingText={pendingLabel} className="mt-2 self-start px-6">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}

'@
Set-Content -LiteralPath "app/(app)/products/variant-form.tsx" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing lib/validation/products.ts"
New-Item -ItemType Directory -Force -Path "lib/validation" | Out-Null
$content = @'
import { z } from "zod";

/**
 * Shared client+server validation for product/variant create+edit forms
 * (Phase 5). Same rationale as lib/validation/branches.ts: the Server
 * Action re-validates this, the client is never trusted on its own.
 */

export const UNITS_OF_MEASURE = [
  { value: "each", label: "Each" },
  { value: "kg", label: "Kilogram (kg)" },
  { value: "g", label: "Gram (g)" },
  { value: "litre", label: "Litre" },
  { value: "ml", label: "Millilitre (ml)" },
  { value: "box", label: "Box" },
  { value: "pack", label: "Pack" },
  { value: "dozen", label: "Dozen" },
  { value: "bag", label: "Bag" },
  { value: "carton", label: "Carton" },
  { value: "meter", label: "Meter" },
  { value: "set", label: "Set" },
] as const;

const UNIT_VALUES = UNITS_OF_MEASURE.map((u) => u.value) as [string, ...string[]];

export const TAX_CATEGORIES = [
  { value: "standard", label: "Standard-rated" },
  { value: "zero_rated", label: "Zero-rated" },
  { value: "exempt", label: "VAT-exempt" },
] as const;

const TAX_CATEGORY_VALUES = TAX_CATEGORIES.map((c) => c.value) as [string, ...string[]];

const optionalTrimmed = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

export const productDetailsSchema = z.object({
  name: z.string().trim().min(1, "Product name is required").max(200),
  description: optionalTrimmed(2000),
  category: optionalTrimmed(100),
  unitOfMeasure: z.enum(UNIT_VALUES),
  taxCategory: z.enum(TAX_CATEGORY_VALUES),
});

export type ProductDetailsInput = z.infer<typeof productDetailsSchema>;

// SKU is optional (0014 — not every business assigns one to every item),
// same shape as barcode: trimmed, capped at 64 chars, blank is allowed.
const skuSchema = optionalTrimmed(64);
const barcodeSchema = optionalTrimmed(64);
// Percent-free decimal amount (see lib/money/money.ts — this is the
// major-unit decimal a numeric(14,2) column stores; conversion to integer
// minor units happens only where arithmetic is done, e.g. the POS/sales
// phase, not here).
const priceSchema = z.coerce.number({ invalid_type_error: "Enter a number" }).finite().min(0, "Must be zero or more");

/**
 * One row of the variant-rows editor. variantOptions keys must exactly
 * match the product's variantOptionNames (checked in the schemas below,
 * since a lone variant has no product context to check against). Values
 * are intentionally NOT required here (no .min(1)) even though an empty
 * one is invalid — validateVariantOptionKeys() below is the sole place
 * that flags a missing/empty option value, so there's exactly one error
 * path/message for it. Chaining .min(1) here too would let Zod's own
 * per-value check fail first, which (per Zod's refinement semantics)
 * skips the superRefine below entirely and raises its error at a nested
 * path ("variants.0.variantOptions.Size") the form never looks up —
 * silently swallowing the message instead of showing it. Caught by
 * tracing through exactly this "leave an option blank" path, not assumed.
 */
export const variantRowSchema = z.object({
  sku: skuSchema,
  barcode: barcodeSchema,
  variantOptions: z.record(z.string(), z.string().trim()).default({}),
  costPrice: priceSchema.default(0),
  sellingPrice: priceSchema,
});

export type VariantRowInput = z.infer<typeof variantRowSchema>;

function validateVariantOptionKeys(
  variants: VariantRowInput[],
  optionNames: string[],
  ctx: z.RefinementCtx,
  path: (index: number) => (string | number)[]
) {
  const expected = new Set(optionNames);
  variants.forEach((variant, index) => {
    const keys = Object.keys(variant.variantOptions);
    const missing = optionNames.filter((name) => !variant.variantOptions[name]?.trim());
    const extra = keys.filter((key) => !expected.has(key));
    if (missing.length > 0 || extra.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          optionNames.length > 0
            ? `Set a value for: ${optionNames.join(", ")}`
            : "This product has no variant options — leave these blank.",
        path: path(index),
      });
    }
  });
}

function validateNoDuplicates(variants: VariantRowInput[], ctx: z.RefinementCtx, path: (index: number, field: "sku" | "barcode") => (string | number)[]) {
  const seenSkus = new Map<string, number>();
  const seenBarcodes = new Map<string, number>();
  variants.forEach((variant, index) => {
    // sku is optional (0014) — multiple blank SKUs in one submission are
    // fine (they all become NULL, and NULL never collides with itself in
    // Postgres either), so only check duplicates when a SKU was actually
    // given, same as barcode already does below.
    if (variant.sku) {
      const skuKey = variant.sku.toLowerCase();
      if (seenSkus.has(skuKey)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate SKU in this submission.", path: path(index, "sku") });
      }
      seenSkus.set(skuKey, index);
    }

    if (variant.barcode) {
      const barcodeKey = variant.barcode.toLowerCase();
      if (seenBarcodes.has(barcodeKey)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate barcode in this submission.", path: path(index, "barcode") });
      }
      seenBarcodes.set(barcodeKey, index);
    }
  });
}

/** Full create-product form: product details + variant axis names + >=1 starting variant. */
export const createProductSchema = productDetailsSchema
  .extend({
    variantOptionNames: z.array(z.string().trim().min(1).max(40)).max(3).default([]),
    variants: z.array(variantRowSchema).min(1, "At least one variant is required").max(200),
  })
  .superRefine((data, ctx) => {
    validateVariantOptionKeys(data.variants, data.variantOptionNames, ctx, (i) => ["variants", i, "variantOptions"]);
    validateNoDuplicates(data.variants, ctx, (i, field) => ["variants", i, field]);
  });

export type CreateProductInput = z.infer<typeof createProductSchema>;

/** Add-variant / edit-variant form for a single row against a known product (option names come from the product, not the form). */
export function variantFormSchema(optionNames: string[]) {
  return variantRowSchema.superRefine((data, ctx) => {
    validateVariantOptionKeys([data], optionNames, ctx, () => ["variantOptions"]);
  });
}

export const productStatusSchema = z.enum(["active", "archived"]);

'@
Set-Content -LiteralPath "lib/validation/products.ts" -Value $content -NoNewline -Encoding UTF8

Write-Host "Writing supabase/migrations/0014_products_optional_sku.sql"
New-Item -ItemType Directory -Force -Path "supabase/migrations" | Out-Null
$content = @'
-- Busihub — 0014: make product_variants.sku optional
--
-- Feedback from real usage: not every business assigns a SKU to every
-- item — barcode alone, or neither, is common for small retailers, and
-- Phase 5 originally required one on every variant.
--
-- sku already has two things that keep working once it's nullable:
--   1. `unique (business_id, sku)` — Postgres unique constraints already
--      treat every NULL as distinct from every other NULL by default
--      (standard SQL semantics, and true on this Postgres 16 project
--      since NULLS NOT DISTINCT was never specified), so any number of
--      variants can have no SKU without colliding. Same reasoning
--      barcode's partial unique index already relies on (0013) — sku
--      doesn't even need a partial index for this, a plain unique
--      constraint already behaves this way.
--   2. `check (char_length(trim(sku)) > 0)` — a CHECK constraint whose
--      expression evaluates to NULL (which it will, for a NULL sku) is
--      treated as satisfied by Postgres, not violated; only a FALSE
--      result (e.g. an empty string) is rejected. Verified directly
--      against a real table before writing this migration: inserting
--      NULL succeeded, inserting '' still correctly failed the check.
-- So the only change actually needed is dropping NOT NULL.
alter table product_variants alter column sku drop not null;

-- create_product() (0013) passed sku straight through without the
-- nullif(..., '') it already gave barcode — harmless when sku was
-- required (an empty string was rejected by the check constraint either
-- way), but now that blank is a legitimate "no SKU" choice, a blank form
-- field should become NULL cleanly rather than surfacing a raw check-
-- constraint error. Re-defining the function (safe — this changes its
-- body, not the table it already wrote data into) to match barcode's
-- existing handling.
create or replace function create_product(
  p_business_id uuid,
  p_name text,
  p_description text,
  p_category text,
  p_unit_of_measure text,
  p_tax_category text,
  p_variant_option_names text[],
  p_variants jsonb -- array of {sku, barcode, variant_options, cost_price, selling_price}
)
returns uuid
language plpgsql
as $$
declare
  v_product_id uuid;
  v_variant jsonb;
  v_has_variants boolean;
begin
  if p_variants is null or jsonb_array_length(p_variants) < 1 then
    raise exception 'At least one variant is required' using errcode = 'P0001';
  end if;

  v_has_variants := coalesce(array_length(p_variant_option_names, 1), 0) > 0;

  insert into products (
    business_id, name, description, category, unit_of_measure, tax_category,
    has_variants, variant_option_names, created_by
  )
  values (
    p_business_id, p_name, nullif(p_description, ''), nullif(p_category, ''),
    p_unit_of_measure, p_tax_category, v_has_variants, p_variant_option_names, auth.uid()
  )
  returning id into v_product_id;

  for v_variant in select * from jsonb_array_elements(p_variants)
  loop
    insert into product_variants (
      product_id, sku, barcode, variant_options, cost_price, selling_price, is_default
    )
    values (
      v_product_id,
      nullif(v_variant ->> 'sku', ''),
      nullif(v_variant ->> 'barcode', ''),
      coalesce(v_variant -> 'variant_options', '{}'::jsonb),
      coalesce((v_variant ->> 'cost_price')::numeric, 0),
      (v_variant ->> 'selling_price')::numeric,
      not v_has_variants
    );
  end loop;

  return v_product_id;
end;
$$;

'@
Set-Content -LiteralPath "supabase/migrations/0014_products_optional_sku.sql" -Value $content -NoNewline -Encoding UTF8

Write-Host ""
Write-Host "Done. Files written:" -ForegroundColor Green
Write-Host "  app/(app)/branches/page.tsx"
Write-Host "  app/(app)/branches/[id]/page.tsx"
Write-Host "  app/(app)/products/[id]/page.tsx"
Write-Host "  app/(app)/products/[id]/variants/[variantId]/edit/page.tsx"
Write-Host "  app/(app)/products/actions.ts"
Write-Host "  app/(app)/products/page.tsx"
Write-Host "  app/(app)/products/product-form.tsx"
Write-Host "  app/(app)/products/variant-form.tsx"
Write-Host "  lib/validation/products.ts"
Write-Host "  supabase/migrations/0014_products_optional_sku.sql"

Write-Host ""
Write-Host "Next: npm run db:migrate  (applies migration 0014), then npm run typecheck && npm run lint && npm run test && npm run build" -ForegroundColor Yellow
