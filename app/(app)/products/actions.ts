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
    categoryName: formData.get("categoryName"),
    unitOfMeasure: formData.get("unitOfMeasure"),
    taxCategory: formData.get("taxCategory"),
    type: formData.get("type") || "product",
    variantOptionNames: jsonField<string[]>(formData, "variantOptionNamesJson", []),
    variants: jsonField<unknown[]>(formData, "variantsJson", []),
    branchId: formData.get("branchId"),
    durationMinutes: formData.get("durationMinutes"),
  };
}

/**
 * Turns a typed category name into a real category_id — reusing an
 * existing category (matched case-insensitively in application code, not
 * an ILIKE pattern, so a name containing "%" or "_" can't cause a false
 * match) or creating a new one when nothing matches. Blank means
 * "Uncategorized", unchanged from before. Matched against the caller's
 * OWN business only (never trust a client-supplied name to mean a
 * cross-tenant row, same as every other lookup in this file).
 *
 * Reusing/reactivating an existing category only ever needs the
 * permission the calling action already required (products.create or
 * products.edit). Creating a genuinely NEW category additionally needs
 * products.create, checked here explicitly — docs/RBAC.md's "Categories
 * reuse products.*" rule means someone with only products.edit can
 * re-point a product at any existing category, but cannot mint a new one
 * just by typing it into this form.
 */
async function resolveCategoryId(
  supabase: SupabaseServerClient,
  businessId: string,
  canCreateCategory: boolean,
  rawName: FormDataEntryValue | string | null | undefined
): Promise<{ categoryId: string | null } | { fieldError: string }> {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) return { categoryId: null };
  const key = name.toLowerCase();

  // A business has at most a few dozen categories — matched here in
  // application code rather than pushed into a `.ilike()` filter, which
  // would treat "%"/"_" in a typed name as SQL wildcards instead of the
  // plain characters a user meant.
  const { data: existingRows, error: lookupError } = await supabase
    .from("categories")
    .select("id, name, status, created_at")
    .eq("business_id", businessId);

  if (lookupError) {
    console.error("resolveCategoryId: lookup failed", lookupError);
    return { fieldError: "Something went wrong looking up that category. Please try again." };
  }

  const existing = (existingRows ?? [])
    .filter((c) => c.name.trim().toLowerCase() === key)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];

  if (existing) {
    if (existing.status === "archived") {
      // Typing an archived category's name brings it back rather than
      // colliding with categories' unique(business_id, name) constraint
      // by trying to insert a second row under the same name.
      const { error: reactivateError } = await supabase
        .from("categories")
        .update({ status: "active" })
        .eq("id", existing.id)
        .eq("business_id", businessId);
      if (reactivateError) {
        console.error("resolveCategoryId: reactivate failed", reactivateError);
        return { fieldError: "Something went wrong restoring that category. Please try again." };
      }
    }
    return { categoryId: existing.id };
  }

  if (!canCreateCategory) {
    return {
      fieldError: `No category named "${name}" exists yet, and you don't have permission to add one — choose an existing category, or ask an admin to add it.`,
    };
  }

  const { data: created, error: insertError } = await supabase
    .from("categories")
    .insert({ business_id: businessId, name })
    .select("id")
    .single();

  if (insertError) {
    // A concurrent request created the exact same name between the
    // lookup above and this insert — reuse it rather than failing the
    // whole save over a race that isn't really an error to the person
    // filling in the form.
    if (insertError.code === "23505") {
      const { data: racedRows } = await supabase.from("categories").select("id, name").eq("business_id", businessId);
      const raced = (racedRows ?? []).find((c) => c.name.trim().toLowerCase() === key);
      if (raced) return { categoryId: raced.id };
    }
    console.error("resolveCategoryId: insert failed", insertError);
    return { fieldError: "Couldn't add that category. Please try again." };
  }

  return { categoryId: created.id };
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

  const { name, description, categoryName, unitOfMeasure, taxCategory, type, variantOptionNames, variants, branchId, durationMinutes } =
    parsed.data;

  // Always true here: creating a product at all already required
  // products.create above, which is the exact permission needed to add a
  // brand-new category too — see resolveCategoryId's own comment.
  const categoryResult = await resolveCategoryId(supabase, businessId, true, categoryName);
  if ("fieldError" in categoryResult) {
    return { error: categoryResult.fieldError, fieldErrors: { categoryName: categoryResult.fieldError } };
  }

  const { error } = await supabase.rpc("create_product", {
    p_business_id: businessId,
    p_name: name,
    p_description: description || null,
    p_category_id: categoryResult.categoryId,
    p_unit_of_measure: unitOfMeasure,
    p_tax_category: taxCategory,
    p_variant_option_names: variantOptionNames,
    p_variants: variants.map((v: VariantRowInput) => ({
      sku: v.sku || null,
      barcode: v.barcode || null,
      variant_options: v.variantOptions,
      cost_price: v.costPrice,
      selling_price: v.sellingPrice,
      // Opening stock becomes a real `receive` movement inside
      // create_product, in the same transaction as the product itself
      // (migration 0026) — never a written stock level. For a service,
      // create_product (0040) ignores this entirely, regardless of what
      // is sent, since a service never carries stock.
      opening_stock: v.openingStock,
    })),
    p_branch_id: branchId || null,
    p_type: type,
    // Meaningless for a product — create_product (0041) forces this to
    // null server-side for type='product' regardless of what is sent.
    p_duration_minutes: durationMinutes ?? null,
  });

  if (error) {
    console.error("createProduct: rpc failed", error);
    const dup = error.code === "23505" ? duplicateFieldFromError(error.message ?? "") : null;
    if (dup) {
      return { error: dup.text, fieldErrors: { [dup.field]: dup.text } };
    }
    // "Choose which branch the opening stock is at", "Duration must be a
    // positive number of minutes" — written for the person filling in
    // the form.
    if (error.code === "P0001" && error.message) {
      return { error: error.message };
    }
    if (error.code === "P0002") {
      return { error: "That branch or category could not be found." };
    }
    // Opening stock goes through the inventory ledger, so it needs
    // inventory.receive. Someone who may add products but not receive
    // stock should be told which half was refused.
    if (error.code === "42501") {
      return {
        error:
          "You can add the product, but not the opening stock — that needs permission to receive inventory. Leave the stock boxes empty, or ask an owner.",
      };
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
    categoryName: formData.get("categoryName"),
    unitOfMeasure: formData.get("unitOfMeasure"),
    taxCategory: formData.get("taxCategory"),
    durationMinutes: formData.get("durationMinutes"),
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

  const { name, description, categoryName, unitOfMeasure, taxCategory, durationMinutes } = parsed.data;

  // Reusing/reactivating an existing category only needs the
  // products.edit already required above; minting a brand-new one from
  // this same box additionally needs products.create — checked fresh
  // here rather than assumed, since editing a product's other details
  // and adding a whole new category are different permissions in this
  // project (docs/RBAC.md's "Categories reuse products.*").
  const canCreateCategory = await hasPermission(supabase, businessId, PERMISSIONS.PRODUCTS_CREATE);
  const categoryResult = await resolveCategoryId(supabase, businessId, canCreateCategory, categoryName);
  if ("fieldError" in categoryResult) {
    return { error: categoryResult.fieldError, fieldErrors: { categoryName: categoryResult.fieldError } };
  }

  // Need the product's own type to decide whether duration_minutes is
  // meaningful — it is forced null for a product regardless of what was
  // sent, the same treatment create_product() gives it at creation time.
  const { data: existing, error: existingError } = await supabase
    .from("products")
    .select("type")
    .eq("id", productId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (existingError || !existing) {
    console.error("updateProductDetails: product lookup failed", existingError);
    return { error: "Couldn't find this product." };
  }

  const { error } = await supabase
    .from("products")
    .update({
      name,
      description: description || null,
      category_id: categoryResult.categoryId,
      unit_of_measure: unitOfMeasure,
      tax_category: taxCategory,
      duration_minutes: existing.type === "service" ? durationMinutes ?? null : null,
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

/**
 * Plain (no useFormState) action bound to a product id and target
 * availability, same shape as setProductStatus above — but gated by
 * products.edit, not products.archive: this is a catalog attribute
 * (like category or duration), not a lifecycle transition, so it needs
 * no confirmation step and rides the same permission every other
 * catalog-attribute edit already needs (migration 0043's file header).
 * The triggering button is only ever rendered for a caller who already
 * has products.edit (cosmetic check), so a thrown error here means
 * permissions changed out from under them mid-session, not the expected
 * path.
 */
export async function setProductTillAvailability(productId: string, availableAtTill: boolean): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const businessId = await requireProductPermission(supabase, PERMISSIONS.PRODUCTS_EDIT);

  const { error } = await supabase
    .from("products")
    .update({ available_at_till: availableAtTill })
    .eq("id", productId)
    .eq("business_id", businessId);

  if (error) {
    console.error("setProductTillAvailability: update failed", error);
    throw new Error("Couldn't update whether this shows up at the till. Please try again.");
  }

  revalidatePath("/products");
  revalidatePath(`/products/${productId}`);
  revalidatePath("/till");
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