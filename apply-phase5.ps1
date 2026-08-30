$ErrorActionPreference = 'Stop'

# Creates directories (harmless if they already exist) then writes every
# Phase 5 file. New-Item uses plain -Path (it has no -LiteralPath param at
# all in Windows PowerShell 5.1 -- confirmed by a real error); Set-Content
# uses -LiteralPath (needed for [id]/[variantId] -- confirmed working).
# THIS VERSION ALSO FIXES A REAL ENCODING BUG: this .ps1 file itself is now
# saved WITH a UTF-8 BOM. Without one, Windows PowerShell 5.1 reads a
# script file using the system ANSI codepage, not UTF-8 -- so any non-ASCII
# character embedded in this script (em dashes, ellipses, GH₵, middle dots)
# was silently mis-decoded before ever being written out. Confirmed by the
# real test failure: formatMoney(12345, "GHS") came back "GHâ‚µ123.45" instead
# of "GH₵123.45" -- exactly the mojibake pattern of UTF-8 bytes misread as
# Windows-1252. Re-running this corrected script overwrites every affected
# file with the correct text.

New-Item -ItemType Directory -Force -Path "app\(app)" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "app\(app)\products" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "app\(app)\products\[id]" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "app\(app)\products\[id]\edit" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "app\(app)\products\[id]\variants\[variantId]\edit" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "app\(app)\products\[id]\variants\new" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "app\(app)\products\new" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "components\ui" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "lib\money" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "lib\validation" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "supabase\migrations" -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path "tests\unit" -ErrorAction SilentlyContinue | Out-Null

Write-Host "Writing app\(app)\layout.tsx..."
@'
import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { LogoutButton } from "@/components/logout-button";

/**
 * Every route under (app) requires a signed-in user with a linked
 * business profile. This is a convenience redirect for UX — the real
 * security boundary is RLS (every query below this layout is still
 * scoped by Postgres, not by this check) — but without it a
 * signed-out visitor would just see empty states instead of being sent
 * to /login, which is confusing rather than insecure.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    // businesses has two FKs to/from profiles (profiles.business_id ->
    // businesses.id, and businesses.created_by -> profiles.id), so the
    // embed must be disambiguated with the FK constraint name — a bare
    // `businesses (name)` is rejected by PostgREST with PGRST201
    // ("more than one relationship was found"). Confirmed against the
    // real schema; profiles_business_id_fkey is the one we want here.
    .select("id, first_name, last_name, business_id, businesses!profiles_business_id_fkey (name)")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    // A genuine query failure (RLS denial, PostgREST embed error, etc.)
    // looks identical to "no profile yet" if we only check `!profile` —
    // that swallowed real errors during testing and made this
    // undiagnosable. Log it distinctly so the two cases don't get
    // confused again.
    console.error("(app) layout: profiles query failed", profileError);
    redirect("/login");
  }

  if (!profile) {
    // Authenticated but no business/profile link yet (e.g. email
    // confirmation pending, or the register_business() RPC failed after
    // signUp — see app/(auth)/login/actions.ts). Nothing under (app) can
    // render sensibly without a business_id.
    redirect("/login");
  }

  const businessName = (profile as unknown as { businesses: { name: string } | null }).businesses?.name;

  // Cosmetic nav visibility only — every page/action behind these links
  // re-checks the same permission server-side (Section 49).
  const [canManageBranches, canManageBusiness, canViewProducts] = await Promise.all([
    hasPermission(supabase, profile.business_id!, PERMISSIONS.BRANCHES_MANAGE),
    hasPermission(supabase, profile.business_id!, PERMISSIONS.BUSINESS_MANAGE),
    hasPermission(supabase, profile.business_id!, PERMISSIONS.PRODUCTS_VIEW),
  ]);

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="flex flex-col gap-3 border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-brand-600 px-2 py-1 text-sm font-bold text-white">B</span>
          <span className="font-semibold">{businessName ?? "Busihub"}</span>
        </div>
        <nav className="flex items-center gap-4 text-sm font-medium text-neutral-600 dark:text-neutral-300">
          <Link href="/dashboard" className="hover:text-neutral-900 dark:hover:text-white">
            Dashboard
          </Link>
          {canViewProducts ? (
            <Link href="/products" className="hover:text-neutral-900 dark:hover:text-white">
              Products
            </Link>
          ) : null}
          {canManageBranches ? (
            <Link href="/branches" className="hover:text-neutral-900 dark:hover:text-white">
              Branches
            </Link>
          ) : null}
          {canManageBusiness ? (
            <Link href="/settings/business" className="hover:text-neutral-900 dark:hover:text-white">
              Settings
            </Link>
          ) : null}
        </nav>
        <div className="flex items-center gap-4">
          <span className="hidden text-sm text-neutral-500 sm:inline">
            {profile.first_name} {profile.last_name}
          </span>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

'@ | Set-Content -LiteralPath "app\(app)\layout.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\products\actions.ts..."
@'
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
      sku: v.sku,
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
    sku,
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
    sku,
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

'@ | Set-Content -LiteralPath "app\(app)\products\actions.ts" -Encoding UTF8

Write-Host "Writing app\(app)\products\page.tsx..."
@'
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
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const { q, status } = await searchParams;
  const activeStatus = status === "archived" ? "archived" : "active";

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const [canCreate, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CREATE),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
  ]);
  const currencyCode = business?.currency_code ?? "GHS";

  // RLS-scoped — no explicit .eq("business_id", ...) needed (Section 4, Section 49).
  let query = supabase
    .from("products")
    .select("id, name, category, status, has_variants, product_variants(selling_price)")
    .eq("status", activeStatus)
    .order("name", { ascending: true });

  if (q && q.trim().length > 0) {
    query = query.ilike("name", `%${q.trim()}%`);
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
            href={{ pathname: "/products", query: { ...(q ? { q } : {}) } }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              activeStatus === "active" ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            Active
          </Link>
          <Link
            href={{ pathname: "/products", query: { status: "archived", ...(q ? { q } : {}) } }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              activeStatus === "archived" ? "bg-brand-600 text-white" : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            Archived
          </Link>
        </div>
        <form className="flex gap-2" action="/products">
          {activeStatus === "archived" ? <input type="hidden" name="status" value="archived" /> : null}
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by name…"
            className="min-h-[44px] w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white sm:w-64"
          />
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

'@ | Set-Content -LiteralPath "app\(app)\products\page.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\products\new\page.tsx..."
@'
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { ProductForm } from "../product-form";

export const metadata = { title: "Add product" };

export default async function NewProductPage() {
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canCreate = await hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CREATE);

  // Cosmetic — createProduct() re-checks this server-side regardless.
  if (!canCreate) {
    redirect("/products");
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Add product</h1>
        <p className="text-neutral-500">New products start active.</p>
      </div>
      <ProductForm />
    </div>
  );
}

'@ | Set-Content -LiteralPath "app\(app)\products\new\page.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\products\product-form.tsx..."
@'
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
                    label="SKU"
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

'@ | Set-Content -LiteralPath "app\(app)\products\product-form.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\products\product-details-form.tsx..."
@'
"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/button";
import { UNITS_OF_MEASURE, TAX_CATEGORIES, type ProductDetailsInput } from "@/lib/validation/products";
import type { FormState } from "./actions";

const initialState: FormState = {};
const UNIT_OPTIONS = UNITS_OF_MEASURE.map((u) => ({ value: u.value, label: u.label }));
const TAX_OPTIONS = TAX_CATEGORIES.map((c) => ({ value: c.value, label: c.label }));

interface ProductDetailsFormProps {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  defaultValues: ProductDetailsInput;
}

/** Edits a product's shared catalog fields only — SKU/barcode/price live per-variant and are edited from that variant's own page. */
export function ProductDetailsForm({ action, defaultValues }: ProductDetailsFormProps) {
  const [state, formAction] = useFormState(action, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <Field label="Product name" name="name" required defaultValue={defaultValues.name} error={state.fieldErrors?.name} />
      <Textarea label="Description (optional)" name="description" defaultValue={defaultValues.description} error={state.fieldErrors?.description} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Category (optional)" name="category" defaultValue={defaultValues.category} error={state.fieldErrors?.category} />
        <Select
          label="Unit of measure"
          name="unitOfMeasure"
          defaultValue={defaultValues.unitOfMeasure}
          error={state.fieldErrors?.unitOfMeasure}
          options={UNIT_OPTIONS}
        />
        <Select
          label="Tax category"
          name="taxCategory"
          defaultValue={defaultValues.taxCategory}
          error={state.fieldErrors?.taxCategory}
          options={TAX_OPTIONS}
        />
      </div>

      <SubmitButton pendingText="Saving…" className="mt-2 self-start px-6">
        Save changes
      </SubmitButton>
    </form>
  );
}

'@ | Set-Content -LiteralPath "app\(app)\products\product-details-form.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\products\variant-form.tsx..."
@'
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
        <Field label="SKU" name="sku" required defaultValue={defaultValues?.sku} error={state.fieldErrors?.sku} />
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

'@ | Set-Content -LiteralPath "app\(app)\products\variant-form.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\products\status-toggle-button.tsx..."
@'
"use client";

import { SubmitButton } from "@/components/ui/button";

/** Wraps a bound plain (no-useFormState) status-change action as a one-button form — same pattern as branches/set-main-branch-button.tsx. */
export function StatusToggleButton({
  action,
  label,
  pendingLabel,
  variant = "secondary",
}: {
  action: () => Promise<void>;
  label: string;
  pendingLabel: string;
  variant?: "secondary" | "danger" | "ghost";
}) {
  return (
    <form action={action}>
      <SubmitButton variant={variant} pendingText={pendingLabel}>
        {label}
      </SubmitButton>
    </form>
  );
}

'@ | Set-Content -LiteralPath "app\(app)\products\status-toggle-button.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\products\[id]\page.tsx..."
@'
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

  const variants = [...product.product_variants].sort((a, b) => a.sku.localeCompare(b.sku));

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
                    <td className="px-4 py-3 font-medium">{variant.sku}</td>
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

'@ | Set-Content -LiteralPath "app\(app)\products\[id]\page.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\products\[id]\edit\page.tsx..."
@'
import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { ProductDetailsForm } from "../../product-details-form";
import { updateProductDetails } from "../../actions";

export const metadata = { title: "Edit product" };

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canEdit = await hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_EDIT);

  // Cosmetic — updateProductDetails() re-checks this server-side regardless.
  if (!canEdit) {
    redirect(`/products/${id}`);
  }

  // RLS-scoped: a product id from another tenant simply won't be found here.
  const { data: product, error } = await supabase
    .from("products")
    .select("id, name, description, category, unit_of_measure, tax_category")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("EditProductPage: product query failed", error);
  }

  if (!product) {
    notFound();
  }

  const boundUpdateProductDetails = updateProductDetails.bind(null, product.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Edit product</h1>
        <p className="text-neutral-500">{product.name}</p>
      </div>
      <ProductDetailsForm
        action={boundUpdateProductDetails}
        defaultValues={{
          name: product.name,
          description: product.description ?? "",
          category: product.category ?? "",
          unitOfMeasure: product.unit_of_measure,
          taxCategory: product.tax_category as "standard" | "zero_rated" | "exempt",
        }}
      />
    </div>
  );
}

'@ | Set-Content -LiteralPath "app\(app)\products\[id]\edit\page.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\products\[id]\variants\new\page.tsx..."
@'
import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { VariantForm } from "../../../variant-form";
import { addVariant } from "../../../actions";

export const metadata = { title: "Add variant" };

export default async function NewVariantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);
  const canEdit = await hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_EDIT);

  // Cosmetic — addVariant() re-checks this server-side regardless.
  if (!canEdit) {
    redirect(`/products/${id}`);
  }

  const { data: product, error } = await supabase
    .from("products")
    .select("id, name, has_variants, variant_option_names")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("NewVariantPage: product query failed", error);
  }

  if (!product) {
    notFound();
  }

  // This phase doesn't support turning a simple product into a variant one
  // after the fact — see supabase/migrations/0013's file header.
  if (!product.has_variants) {
    redirect(`/products/${product.id}`);
  }

  const boundAddVariant = addVariant.bind(null, product.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Add variant</h1>
        <p className="text-neutral-500">{product.name}</p>
      </div>
      <VariantForm
        action={boundAddVariant}
        optionNames={product.variant_option_names as string[]}
        canSetPrice
        submitLabel="Add variant"
        pendingLabel="Adding…"
      />
    </div>
  );
}

'@ | Set-Content -LiteralPath "app\(app)\products\[id]\variants\new\page.tsx" -Encoding UTF8

Write-Host "Writing app\(app)\products\[id]\variants\[variantId]\edit\page.tsx..."
@'
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
          {product.name} · {variant.sku}
        </p>
      </div>
      <VariantForm
        action={boundUpdateVariant}
        optionNames={product.variant_option_names as string[]}
        canSetPrice={canChangePrice}
        defaultValues={{
          sku: variant.sku,
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

'@ | Set-Content -LiteralPath "app\(app)\products\[id]\variants\[variantId]\edit\page.tsx" -Encoding UTF8

Write-Host "Writing components\ui\textarea.tsx..."
@'
"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  error?: string;
}

/** Labeled textarea, styled to match components/ui/field.tsx. */
export function Textarea({ label, error, className, id, rows = 3, ...props }: TextareaProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
        {label}
      </label>
      <textarea
        id={inputId}
        rows={rows}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          "rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-base text-neutral-900",
          "focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30",
          "dark:border-neutral-700 dark:bg-neutral-900 dark:text-white",
          error && "border-red-500 focus:border-red-500 focus:ring-red-500/30",
          className
        )}
        {...props}
      />
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

'@ | Set-Content -LiteralPath "components\ui\textarea.tsx" -Encoding UTF8

Write-Host "Writing lib\validation\products.ts..."
@'
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

const skuSchema = z.string().trim().min(1, "SKU is required").max(64);
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
    const skuKey = variant.sku.toLowerCase();
    if (seenSkus.has(skuKey)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate SKU in this submission.", path: path(index, "sku") });
    }
    seenSkus.set(skuKey, index);

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

'@ | Set-Content -LiteralPath "lib\validation\products.ts" -Encoding UTF8

Write-Host "Writing lib\validation\zod-helpers.ts..."
@'
import type { ZodError } from "zod";

/**
 * Flattens a ZodError into the { fieldName: message } shape every
 * form-state action in this app returns (first issue per field wins).
 * The key is the full dotted path (e.g. "variants.0.sku") so nested
 * array/object schemas (Phase 5's per-variant rows) can look up an error
 * for a specific row/field, not just a top-level one — for every schema
 * up to Phase 4 the path is always a single segment, so this is identical
 * to the old "path[0] only" behavior for all existing callers.
 */
export function zodFieldErrors(error: ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}

'@ | Set-Content -LiteralPath "lib\validation\zod-helpers.ts" -Encoding UTF8

Write-Host "Writing lib\money\money.ts..."
@'
/**
 * Decimal-safe money helpers (Section 22: never use floating point for
 * anything that touches a price, total, or balance).
 *
 * We represent money as integer minor units (pesewas for GHS, cents for
 * most other currencies) inside all arithmetic, and only format to a
 * decimal string at the boundary (UI/receipts). This sidesteps
 * `0.1 + 0.2 !== 0.3`-class bugs entirely rather than trying to round our
 * way out of them after the fact.
 *
 * Postgres-side, the equivalent guarantee comes from every monetary
 * column being `numeric(14,2)` (see supabase/migrations) rather than
 * `float`/`double precision`.
 */

/**
 * PostgREST (what supabase-js talks to) serializes Postgres `numeric`
 * columns as JSON strings, not numbers — deliberately, to avoid silent
 * float precision loss over the wire — while `int`/`real`/`double
 * precision` columns come back as actual JSON numbers. Every
 * numeric(14,2) money column in this schema (product prices, subscription
 * plan prices, …) therefore needs this before arithmetic/formatting;
 * skipping it fails oddly, since `Number.isFinite("12.50")` is false
 * (strict, non-coercing) even though the value is perfectly usable.
 */
export function toNumber(value: number | string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) {
    throw new Error(`toNumber: value must be finite, got ${value}`);
  }
  return n;
}

/** Convert a decimal amount (e.g. from a form input, or a numeric(14,2) column read via supabase-js — see toNumber()) to integer minor units. */
export function toMinorUnits(amount: number | string): number {
  const n = toNumber(amount);
  // Round at the cent level before converting, so floating point
  // representation error in `amount` itself can't leak through.
  return Math.round(n * 100);
}

/** Convert integer minor units back to a decimal number for display. */
export function fromMinorUnits(minorUnits: number): number {
  return minorUnits / 100;
}

/** Format minor units as a currency string, e.g. formatMoney(12345, "GHS") -> "GH₵123.45". */
const CURRENCY_SYMBOLS: Record<string, string> = {
  GHS: "GH₵",
  USD: "$",
  EUR: "€",
  GBP: "£",
  NGN: "₦",
};

export function formatMoney(minorUnits: number, currencyCode: string): string {
  const symbol = CURRENCY_SYMBOLS[currencyCode] ?? `${currencyCode} `;
  const amount = fromMinorUnits(minorUnits);
  return `${symbol}${amount.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export type DiscountType = "percentage" | "fixed";

export interface DiscountInput {
  type: DiscountType;
  /** Percentage as a whole number (5 = 5%), or minor units for a fixed discount. */
  value: number;
}

/**
 * Computes the discount amount in minor units for a given subtotal.
 * A percentage discount is computed against the subtotal and rounded to
 * the nearest minor unit; never allowed to exceed the subtotal itself
 * (a discount can't make a line item negative).
 */
export function calculateDiscountAmount(subtotalMinorUnits: number, discount: DiscountInput): number {
  if (subtotalMinorUnits < 0) {
    throw new Error("calculateDiscountAmount: subtotal cannot be negative");
  }

  let amount: number;
  if (discount.type === "percentage") {
    if (discount.value < 0 || discount.value > 100) {
      throw new Error("calculateDiscountAmount: percentage discount must be between 0 and 100");
    }
    amount = Math.round((subtotalMinorUnits * discount.value) / 100);
  } else {
    if (discount.value < 0) {
      throw new Error("calculateDiscountAmount: fixed discount cannot be negative");
    }
    amount = Math.round(discount.value);
  }

  return Math.min(amount, subtotalMinorUnits);
}

/**
 * Server-side discount authorization check (Section 14). The caller's
 * role carries a maximum discount percentage; this rejects (rather than
 * silently clamping) any discount that exceeds it, so the caller must
 * either reduce the discount or route it through the approval workflow.
 * The percentage cap is compared against the discount's *effective*
 * percentage of the subtotal, so a fixed-amount discount is checked on
 * equal footing with a percentage one.
 */
export function isDiscountWithinCap(
  subtotalMinorUnits: number,
  discount: DiscountInput,
  maxDiscountPercent: number
): boolean {
  if (subtotalMinorUnits <= 0) return true;
  const amount = calculateDiscountAmount(subtotalMinorUnits, discount);
  const effectivePercent = (amount / subtotalMinorUnits) * 100;
  // Small epsilon to absorb rounding, not to widen the cap meaningfully.
  return effectivePercent <= maxDiscountPercent + 0.01;
}

export interface TaxBreakdown {
  vat: number;
  nhilLevy: number;
  getfundLevy: number;
  covidLevy: number;
  total: number;
}

/**
 * Ghana VAT/NHIL/GETFund/COVID levy calculation. Ghana's standard
 * treatment (as of this writing) applies NHIL, GETFund, and the COVID-19
 * levy on the taxable value BEFORE VAT, then VAT is charged on top of
 * that combined amount — i.e. the levies are not themselves subject to
 * VAT, but VAT is computed on (price + levies), not on price alone. Rates
 * are read from business_settings.tax_settings (never hardcoded), passed
 * in here as parameters so this function stays a pure, easily-tested
 * calculation.
 */
export function calculateGhanaTax(
  taxableAmountMinorUnits: number,
  rates: { vatRate: number; nhilLevyRate: number; getfundLevyRate: number; covidLevyRate: number }
): TaxBreakdown {
  if (taxableAmountMinorUnits < 0) {
    throw new Error("calculateGhanaTax: taxable amount cannot be negative");
  }

  const nhilLevy = Math.round(taxableAmountMinorUnits * rates.nhilLevyRate);
  const getfundLevy = Math.round(taxableAmountMinorUnits * rates.getfundLevyRate);
  const covidLevy = Math.round(taxableAmountMinorUnits * rates.covidLevyRate);
  const vatBase = taxableAmountMinorUnits + nhilLevy + getfundLevy + covidLevy;
  const vat = Math.round(vatBase * rates.vatRate);

  return {
    vat,
    nhilLevy,
    getfundLevy,
    covidLevy,
    total: vat + nhilLevy + getfundLevy + covidLevy,
  };
}

'@ | Set-Content -LiteralPath "lib\money\money.ts" -Encoding UTF8

Write-Host "Writing tests\unit\money.test.ts..."
@'
import { describe, expect, it } from "vitest";
import {
  calculateDiscountAmount,
  calculateGhanaTax,
  formatMoney,
  fromMinorUnits,
  isDiscountWithinCap,
  toMinorUnits,
  toNumber,
} from "@/lib/money/money";

describe("minor unit conversion", () => {
  it("converts decimal amounts to integer minor units", () => {
    expect(toMinorUnits(19.99)).toBe(1999);
    expect(toMinorUnits(0.1)).toBe(10);
    expect(toMinorUnits(100)).toBe(10000);
  });

  it("accepts numeric(14,2) columns as returned by supabase-js (JSON strings, not numbers — Phase 5's product prices)", () => {
    // PostgREST serializes `numeric` as a string specifically to avoid
    // float precision loss over the wire — this is what a real
    // product_variants.selling_price value looks like by the time it
    // reaches application code, not a plain JS number.
    expect(toMinorUnits("19.99")).toBe(1999);
    expect(toNumber("19.99")).toBe(19.99);
  });

  it("rejects a non-numeric string instead of silently producing NaN", () => {
    expect(() => toMinorUnits("not-a-number")).toThrow();
    expect(() => toNumber("not-a-number")).toThrow();
  });

  it("treats an empty string as 0, matching JS's own Number('') coercion, rather than throwing", () => {
    // Number("") is 0, not NaN — this is standard (if surprising) JS
    // behavior, not a gap in toNumber(). Documented via a passing test
    // instead of silently relying on it, after an earlier version of this
    // test wrongly asserted toNumber("") throws.
    expect(toNumber("")).toBe(0);
  });

  it("round-trips without floating point drift", () => {
    // The classic 0.1 + 0.2 !== 0.3 failure mode, done in minor units.
    const a = toMinorUnits(0.1);
    const b = toMinorUnits(0.2);
    expect(fromMinorUnits(a + b)).toBe(0.3);
  });

  it("formats money with the correct currency symbol", () => {
    expect(formatMoney(12345, "GHS")).toBe("GH₵123.45");
    expect(formatMoney(100, "USD")).toBe("$1.00");
  });
});

describe("calculateDiscountAmount", () => {
  it("computes a percentage discount", () => {
    expect(calculateDiscountAmount(10000, { type: "percentage", value: 10 })).toBe(1000);
  });

  it("computes a fixed discount", () => {
    expect(calculateDiscountAmount(10000, { type: "fixed", value: 500 })).toBe(500);
  });

  it("never exceeds the subtotal", () => {
    expect(calculateDiscountAmount(1000, { type: "fixed", value: 5000 })).toBe(1000);
    expect(calculateDiscountAmount(1000, { type: "percentage", value: 100 })).toBe(1000);
  });

  it("rejects an out-of-range percentage", () => {
    expect(() => calculateDiscountAmount(1000, { type: "percentage", value: 150 })).toThrow();
    expect(() => calculateDiscountAmount(1000, { type: "percentage", value: -5 })).toThrow();
  });

  it("rejects a negative fixed discount", () => {
    expect(() => calculateDiscountAmount(1000, { type: "fixed", value: -100 })).toThrow();
  });
});

describe("isDiscountWithinCap", () => {
  it("allows a discount at or under the cap", () => {
    expect(isDiscountWithinCap(10000, { type: "percentage", value: 5 }, 5)).toBe(true);
    expect(isDiscountWithinCap(10000, { type: "fixed", value: 500 }, 5)).toBe(true); // exactly 5%
  });

  it("rejects a discount over the cap, including an equivalent fixed amount", () => {
    expect(isDiscountWithinCap(10000, { type: "percentage", value: 20 }, 5)).toBe(false);
    expect(isDiscountWithinCap(10000, { type: "fixed", value: 2000 }, 5)).toBe(false); // 20% in disguise
  });

  it("a manager's higher cap allows what a cashier's cap rejects", () => {
    const subtotal = 10000;
    const discount = { type: "percentage" as const, value: 15 };
    expect(isDiscountWithinCap(subtotal, discount, 5)).toBe(false); // cashier cap
    expect(isDiscountWithinCap(subtotal, discount, 20)).toBe(true); // manager cap
  });
});

describe("calculateGhanaTax", () => {
  const rates = { vatRate: 0.15, nhilLevyRate: 0.025, getfundLevyRate: 0.025, covidLevyRate: 0.01 };

  it("applies NHIL/GETFund/COVID levies before VAT, then VAT on top", () => {
    const result = calculateGhanaTax(10000, rates);
    // levies: 250 + 250 + 100 = 600; VAT base = 10600; VAT = 1590
    expect(result.nhilLevy).toBe(250);
    expect(result.getfundLevy).toBe(250);
    expect(result.covidLevy).toBe(100);
    expect(result.vat).toBe(1590);
    expect(result.total).toBe(250 + 250 + 100 + 1590);
  });

  it("rejects a negative taxable amount", () => {
    expect(() => calculateGhanaTax(-1, rates)).toThrow();
  });

  it("returns all zeros for a zero taxable amount", () => {
    const result = calculateGhanaTax(0, rates);
    expect(result.total).toBe(0);
  });
});

'@ | Set-Content -LiteralPath "tests\unit\money.test.ts" -Encoding UTF8

Write-Host "Writing supabase\migrations\0013_products.sql..."
@'
-- Busihub — 0013: products & product variants (Phase 5)
--
-- Every sellable item is a product_variants row — even a "simple" product
-- with no real variation gets exactly one variant (is_default = true), so
-- every later phase that needs a price/SKU/barcode/stock level (inventory,
-- POS, sales) always reads from the same place regardless of whether the
-- product happens to have Size/Color-style options. products holds the
-- shared catalog info (name, category, tax treatment); product_variants
-- holds everything that can differ per SKU (price, barcode, stock later).
--
-- Permission model (see supabase/migrations/0011 for exactly which seeded
-- role gets which of these — Inventory Manager is the interesting case:
-- create + edit, but neither archive nor change_price):
--   products.create        — create a new product, including its initial
--                             variant(s) and their starting prices.
--   products.edit          — edit a product's non-status fields, edit a
--                             variant's non-price fields (sku/barcode/
--                             variant_options), and add a brand-new variant
--                             to an existing product (its starting price
--                             is a "create", same reasoning as above).
--   products.archive       — flip a product's or variant's status between
--                             active/archived. Deliberately separate from
--                             .edit — an Inventory Manager can restock and
--                             adjust catalog details but not discontinue
--                             a line.
--   products.change_price  — change cost_price/selling_price on a variant
--                             that's already on record. Deliberately
--                             separate from .edit and from the initial
--                             price set at creation/add-variant time — the
--                             idea being "listing something new" is
--                             inventory work, "repricing something already
--                             live" is a pricing decision reserved to
--                             Manager/Owner.
-- RLS below is a coarse row-level backstop (OR of every permission that
-- could legitimately touch the row) — plain RLS can't see which *columns*
-- an UPDATE actually changes. That column-level split is enforced twice:
-- once in the Server Actions (app/(app)/products/actions.ts), which is
-- what gives a clean error message and never even builds an update
-- payload with a field the caller isn't allowed to touch, and again by
-- the enforce_*_field_permissions triggers further down, which compare
-- OLD vs NEW column-by-column and raise if a changed column needs a
-- permission the caller doesn't have — a real database-level backstop,
-- not just app-layer trust, so a request that bypassed the app entirely
-- (a raw call against Supabase's API with a valid session) still can't
-- reprice or archive without the right permission. This was found by
-- testing it directly against local Postgres, not assumed: a first pass
-- of this migration had only the coarse row-level policy below, and a
-- direct SQL UPDATE as an Inventory Manager (products.edit, but neither
-- products.archive nor products.change_price) was able to change a
-- variant's price and status anyway — RLS's OR-of-permissions check
-- doesn't know status/price are gated separately from everything else.

create table products (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null references businesses(id) on delete cascade,
  name                 text not null check (char_length(trim(name)) > 0),
  description          text,
  category             text,
  unit_of_measure      text not null default 'each',
  tax_category         text not null default 'standard'
                         check (tax_category in ('standard', 'zero_rated', 'exempt')),
  has_variants         boolean not null default false,
  -- Names of the option axes that vary per SKU, e.g. {Size, Color}. Empty
  -- for a "simple" product. Kept in sync with has_variants by the check
  -- below rather than trusting the two to be set consistently by callers.
  variant_option_names text[] not null default '{}',
  status               text not null default 'active' check (status in ('active', 'archived')),
  created_by           uuid references profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (business_id, name),
  check (has_variants = (coalesce(array_length(variant_option_names, 1), 0) > 0))
);

create index products_business_id_idx on products (business_id);
create index products_business_category_idx on products (business_id, category);

create trigger set_updated_at
  before update on products
  for each row execute function set_updated_at();

comment on table products is 'Shared catalog info for a sellable item. Prices/SKUs/barcodes live on product_variants — every product has at least one variant, even if it has no real variation (see file header).';

create table product_variants (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid not null references products(id) on delete cascade,
  -- Denormalized from products.business_id by the trigger below (never
  -- trust a client-supplied value here) so RLS can scope this table
  -- directly instead of subquerying through products on every check.
  business_id      uuid not null references businesses(id) on delete cascade,
  sku              text not null check (char_length(trim(sku)) > 0),
  barcode          text,
  -- e.g. {"Size": "M", "Color": "Red"}; '{}' for a simple product's single
  -- default variant.
  variant_options  jsonb not null default '{}'::jsonb,
  cost_price       numeric(14, 2) not null default 0 check (cost_price >= 0),
  selling_price    numeric(14, 2) not null check (selling_price >= 0),
  -- True only for the single auto-created variant of a simple (non-variant)
  -- product — lets later phases (POS/cart) tell "just sell this" apart
  -- from "which variant?" without re-deriving it from variant_options.
  is_default       boolean not null default false,
  status           text not null default 'active' check (status in ('active', 'archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (business_id, sku)
);

create index product_variants_product_id_idx on product_variants (product_id);
create index product_variants_business_id_idx on product_variants (business_id);

-- A barcode is optional but must be unique per business when present.
-- A plain UNIQUE constraint would treat every NULL as distinct already
-- (standard SQL NULL semantics), but a partial index says so explicitly
-- and matches the style of branches_one_main_per_business_idx (0003).
create unique index product_variants_business_barcode_idx
  on product_variants (business_id, barcode)
  where barcode is not null;

create trigger set_updated_at
  before update on product_variants
  for each row execute function set_updated_at();

comment on table product_variants is 'One row per sellable SKU. Every product has >=1 variant; a "simple" product (has_variants = false) has exactly one, with is_default = true and variant_options = {}.';

create or replace function set_product_variant_business_id()
returns trigger
language plpgsql
as $$
begin
  select business_id into new.business_id from products where id = new.product_id;

  if new.business_id is null then
    raise exception 'Invalid product_id: product not found' using errcode = 'P0002';
  end if;

  return new;
end;
$$;

comment on function set_product_variant_business_id() is
  'Forces product_variants.business_id to always match its parent product, regardless of what a caller supplies — closes off a cross-tenant escalation where an insert could otherwise claim a different business_id than the product it is actually attached to. Runs BEFORE INSERT, so RLS''s WITH CHECK evaluates the corrected value, not whatever was sent.';

create trigger set_business_id
  before insert on product_variants
  for each row execute function set_product_variant_business_id();

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table products enable row level security;

create policy products_select on products
  for select
  using (business_id = app_current_business_id() or app_is_super_admin());

create policy products_insert on products
  for insert
  with check (app_has_permission(business_id, 'products.create') or app_is_super_admin());

create policy products_update on products
  for update
  using (
    app_has_permission(business_id, 'products.edit')
    or app_has_permission(business_id, 'products.archive')
    or app_is_super_admin()
  )
  with check (
    app_has_permission(business_id, 'products.edit')
    or app_has_permission(business_id, 'products.archive')
    or app_is_super_admin()
  );

-- No delete policy — products are archived, never hard-deleted (a sale
-- referencing a product later in the project must still resolve).

alter table product_variants enable row level security;

create policy product_variants_select on product_variants
  for select
  using (business_id = app_current_business_id() or app_is_super_admin());

create policy product_variants_insert on product_variants
  for insert
  with check (
    app_has_permission(business_id, 'products.create')
    or app_has_permission(business_id, 'products.edit')
    or app_is_super_admin()
  );

create policy product_variants_update on product_variants
  for update
  using (
    app_has_permission(business_id, 'products.edit')
    or app_has_permission(business_id, 'products.archive')
    or app_has_permission(business_id, 'products.change_price')
    or app_is_super_admin()
  )
  with check (
    app_has_permission(business_id, 'products.edit')
    or app_has_permission(business_id, 'products.archive')
    or app_has_permission(business_id, 'products.change_price')
    or app_is_super_admin()
  );

-- ── column-level enforcement (see file header) ────────────────────────────

create or replace function enforce_product_field_permissions()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status
     and not (app_has_permission(new.business_id, 'products.archive') or app_is_super_admin()) then
    raise exception 'Missing permission: products.archive' using errcode = '42501';
  end if;

  if (
       new.name is distinct from old.name
    or new.description is distinct from old.description
    or new.category is distinct from old.category
    or new.unit_of_measure is distinct from old.unit_of_measure
    or new.tax_category is distinct from old.tax_category
    or new.variant_option_names is distinct from old.variant_option_names
    or new.has_variants is distinct from old.has_variants
  ) and not (app_has_permission(new.business_id, 'products.edit') or app_is_super_admin()) then
    raise exception 'Missing permission: products.edit' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function enforce_product_field_permissions() is
  'BEFORE UPDATE trigger: compares OLD vs NEW column-by-column so products.edit and products.archive stay separately enforced even for an UPDATE that reaches the database directly (not through the Server Action). See file header.';

create trigger enforce_field_permissions
  before update on products
  for each row execute function enforce_product_field_permissions();

create or replace function enforce_product_variant_field_permissions()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status
     and not (app_has_permission(new.business_id, 'products.archive') or app_is_super_admin()) then
    raise exception 'Missing permission: products.archive' using errcode = '42501';
  end if;

  if (new.cost_price is distinct from old.cost_price or new.selling_price is distinct from old.selling_price)
     and not (app_has_permission(new.business_id, 'products.change_price') or app_is_super_admin()) then
    raise exception 'Missing permission: products.change_price' using errcode = '42501';
  end if;

  if (
       new.sku is distinct from old.sku
    or new.barcode is distinct from old.barcode
    or new.variant_options is distinct from old.variant_options
  ) and not (app_has_permission(new.business_id, 'products.edit') or app_is_super_admin()) then
    raise exception 'Missing permission: products.edit' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function enforce_product_variant_field_permissions() is
  'BEFORE UPDATE trigger: same rationale as enforce_product_field_permissions(), but also separates products.change_price (cost_price/selling_price) from products.edit (sku/barcode/variant_options) and products.archive (status).';

create trigger enforce_field_permissions
  before update on product_variants
  for each row execute function enforce_product_variant_field_permissions();

-- ── create_product(): atomic product + initial variant(s) ────────────────
--
-- Mirrors set_main_branch's rationale (0012): a product with zero variants
-- is a broken/unsellable state, so the product row and all of its starting
-- variants are inserted in one transaction — if any variant fails (e.g. a
-- duplicate SKU within the same submission, or a business-wide duplicate
-- via the unique index), the whole thing rolls back instead of leaving a
-- phantom product behind. Deliberately NOT security definer, same as
-- set_main_branch — it runs as the caller, so the RLS policies above
-- apply to its inserts exactly as if the caller ran them directly; that's
-- also what stops p_business_id from being spoofed to another tenant
-- (app_has_permission(p_business_id, ...) only ever returns true for a
-- business the caller actually has a role in).
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
      v_variant ->> 'sku',
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

grant execute on function create_product(uuid, text, text, text, text, text, text[], jsonb) to authenticated;

comment on function create_product(uuid, text, text, text, text, text, text[], jsonb) is
  'Atomically creates a product and its initial variant(s). See file header for the permission model and set_main_branch (0012) for why this needs to be one transaction.';

'@ | Set-Content -LiteralPath "supabase\migrations\0013_products.sql" -Encoding UTF8

Write-Host "Done. All files written."