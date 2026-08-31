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
    branchId: formData.get("branchId"),
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

  const { name, description, category, unitOfMeasure, taxCategory, variantOptionNames, variants, branchId } =
    parsed.data;

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
      // Opening stock becomes a real `receive` movement inside
      // create_product, in the same transaction as the product itself
      // (migration 0026) — never a written stock level.
      opening_stock: v.openingStock,
    })),
    p_branch_id: branchId || null,
  });

  if (error) {
    console.error("createProduct: rpc failed", error);
    const dup = error.code === "23505" ? duplicateFieldFromError(error.message ?? "") : null;
    if (dup) {
      return { error: dup.text, fieldErrors: { [dup.field]: dup.text } };
    }
    // "Choose which branch the opening stock is at", "Opening stock
    // cannot be negative" — written for the person filling in the form.
    if (error.code === "P0001" && error.message) {
      return { error: error.message };
    }
    if (error.code === "P0002") {
      return { error: "That branch could not be found." };
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
