import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { readTillSession } from "@/lib/auth/till-session";
import { signProductPhotoUrls } from "@/lib/storage/product-photos";
import { PinPad, type TillCashier, type TillColleague } from "./pin-pad";
import { Till, type TillProduct, type TillCustomer, type TillStaff, type TillProvider } from "./till";

export const metadata = { title: "Till" };

interface RawVariant {
  id: string;
  sku: string | null;
  barcode: string | null;
  variant_options: Record<string, string> | null;
  selling_price: number | string;
  products: {
    name: string;
    unit_of_measure: string;
    type: "product" | "service";
    duration_minutes: number | null;
    photo_url: string | null;
  } | null;
}

export default async function TillPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string }>;
}) {
  const { branch } = await searchParams;

  const supabase = await createServerSupabaseClient();
  const businessId = await getCurrentBusinessId(supabase);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [canSell, { data: business }] = await Promise.all([
    hasPermission(supabase, businessId, PERMISSIONS.SALES_PROCESS),
    supabase.from("businesses").select("currency_code").eq("id", businessId).maybeSingle(),
  ]);

  // Cosmetic — create_sale() and its RLS re-check this server-side. But a
  // till that renders for someone who cannot sell is just a trap.
  if (!canSell) {
    redirect("/dashboard");
  }

  const currencyCode = business?.currency_code ?? "GHS";

  // Confirm it's actually you. verify_profile_pin() (0039) only ever
  // checks the CALLER's own PIN — there is no way to name anyone else —
  // and readTillSession() only honours a cookie whose identity matches
  // the account that is currently logged in, so switching to a different
  // Supabase login (see the "switch user" flow below) can never inherit
  // someone else's unlock.
  const till = await readTillSession(user.id);

  if (!till) {
    const [{ data: own, error: ownError }, { data: colleagues, error: colleaguesError }] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, display_name, first_name, last_name, pin_set_at, pin_locked_until")
        .eq("id", user.id)
        .maybeSingle(),
      // For the "switch user" step only — no PIN data needed here at all,
      // since switching now means signing in as them (their password),
      // never checking their PIN on this device.
      supabase
        .from("profiles")
        .select("id, display_name, first_name, last_name, email")
        .eq("status", "active")
        .neq("id", user.id)
        .order("first_name"),
    ]);

    if (ownError) {
      console.error("TillPage: own profile query failed", ownError);
    }
    if (colleaguesError) {
      console.error("TillPage: colleagues query failed", colleaguesError);
    }

    const ownName =
      (own as { display_name: string | null } | null)?.display_name ||
      [own?.first_name, own?.last_name].filter(Boolean).join(" ") ||
      "You";

    const cashier: TillCashier = {
      id: user.id,
      name: ownName,
      hasPin: Boolean(own?.pin_set_at),
      lockedUntil: (own as { pin_locked_until: string | null } | null)?.pin_locked_until ?? null,
    };

    const colleagueList: TillColleague[] = (colleagues ?? []).map((c) => ({
      id: c.id,
      name:
        (c as { display_name: string | null }).display_name ||
        [c.first_name, c.last_name].filter(Boolean).join(" ") ||
        "Unnamed",
      email: (c as { email: string | null }).email,
    }));

    return <PinPad cashier={cashier} colleagues={colleagueList} />;
  }

  const [
    { data: branches, error: branchesError },
    { data: variants, error: variantsError },
    { data: customers, error: customersError },
    { data: settings },
    { data: momoEnabled },
    { data: staffRows, error: staffError },
    canOpenDrawer,
  ] = await Promise.all([
    supabase
      .from("branches")
      .select("id, name, is_main")
      .eq("status", "active")
      .order("is_main", { ascending: false })
      .order("name"),
    supabase
      .from("product_variants")
      .select(
        "id, sku, barcode, variant_options, selling_price, products!inner(name, unit_of_measure, status, type, duration_minutes, available_at_till, photo_url)"
      )
      .eq("status", "active")
      .eq("products.status", "active")
      // Migration 0043 — "some products and services should be available
      // in the till": a separate flag from active/archived, defaulting to
      // true, so an item can stay in the full catalog while being hidden
      // from checkout specifically.
      .eq("products.available_at_till", true),
    supabase.from("customers").select("id, name, phone").eq("status", "active").order("name"),
    supabase.from("business_settings").select("pos_settings").eq("business_id", businessId).maybeSingle(),
    // One bit, not the payment settings row: a cashier cannot read that
    // table at all, and does not need to (migration 0024).
    supabase.rpc("business_momo_enabled", { p_business_id: businessId }),
    // Who can be named as having rendered a service line. Any active
    // staff member qualifies — no special tag/permission (migration
    // 0040's header) — so this is every active profile, not a filtered
    // subset like "colleagues" above (which deliberately excludes the
    // caller and is used only for the switch-user flow).
    supabase
      .from("profiles")
      .select("id, display_name, first_name, last_name")
      .eq("status", "active")
      .order("first_name"),
    // "No sale" (migration 0044) — cosmetic here (shows/hides the
    // button); openDrawerNoSale() re-checks this itself, the real gate.
    hasPermission(supabase, businessId, PERMISSIONS.SALES_NO_SALE),
  ]);

  if (branchesError) console.error("TillPage: branches query failed", branchesError);
  if (variantsError) console.error("TillPage: variants query failed", variantsError);
  if (customersError) console.error("TillPage: customers query failed", customersError);
  if (staffError) console.error("TillPage: staff query failed", staffError);

  const activeBranch = branches?.find((b) => b.id === branch) ?? branches?.[0] ?? null;

  if (!activeBranch) {
    return (
      <p className="rounded-xl border border-neutral-200 px-3.5 py-8 text-center text-sm text-neutral-500 dark:border-surface-line dark:text-ink-muted">
        No active branch to sell from. Add one under Branches first.
      </p>
    );
  }

  const [{ data: levels, error: levelsError }, { data: providerRows, error: providersError }] = await Promise.all([
    supabase.from("stock_levels").select("variant_id, quantity").eq("branch_id", activeBranch.id),
    // The second renderer pool (migration 0045) — active service
    // providers tied to THIS branch specifically, unlike staff above
    // (any active profile qualifies business-wide). Queried here, not in
    // the earlier Promise.all, because it depends on activeBranch, which
    // is only known once the branches list itself has come back.
    supabase
      .from("service_providers")
      .select("id, name, title")
      .eq("branch_id", activeBranch.id)
      .eq("status", "active")
      .order("name"),
  ]);

  if (levelsError) console.error("TillPage: stock levels query failed", levelsError);
  if (providersError) console.error("TillPage: service providers query failed", providersError);

  const onHand = new Map<string, number>(
    (levels ?? []).map((l) => [
      (l as { variant_id: string }).variant_id,
      // numeric(14,3) arrives from PostgREST as a string, not a number.
      Number((l as { quantity: number | string }).quantity),
    ])
  );

  // One batched Storage call for the whole till load rather than one per
  // product — the till can browse a hundred-plus items at once, unlike
  // the small lists elsewhere that sign one photo at a time (see
  // lib/storage/product-photos.ts's file header).
  const rawVariants = (variants ?? []) as unknown as RawVariant[];
  const photoUrlsByPath = await signProductPhotoUrls(
    supabase,
    rawVariants.map((v) => v.products?.photo_url ?? null)
  );

  const products: TillProduct[] = rawVariants
    .map((v) => {
      const name = v.products?.name ?? "Unknown product";
      const options = Object.entries(v.variant_options ?? {});
      const label = options.length > 0 ? `${name} — ${options.map(([, val]) => val).join(" / ")}` : name;
      const photoPath = v.products?.photo_url ?? null;
      return {
        variantId: v.id,
        label,
        sku: v.sku,
        barcode: v.barcode,
        price: Number(v.selling_price),
        onHand: onHand.get(v.id) ?? 0,
        unit: v.products?.unit_of_measure ?? "each",
        type: v.products?.type ?? "product",
        durationMinutes: v.products?.duration_minutes ?? null,
        photoUrl: photoPath ? photoUrlsByPath.get(photoPath) ?? null : null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const tillCustomers: TillCustomer[] = (customers ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
  }));

  const staffList: TillStaff[] = (staffRows ?? []).map((s) => ({
    id: s.id,
    name:
      (s as { display_name: string | null }).display_name ||
      [s.first_name, s.last_name].filter(Boolean).join(" ") ||
      "Unnamed",
  }));

  const providerList: TillProvider[] = ((providerRows ?? []) as { id: string; name: string; title: string | null }[]).map(
    (p) => ({ id: p.id, name: p.name, title: p.title })
  );

  const allowNegativeStock = Boolean(
    (settings?.pos_settings as { allow_negative_stock?: boolean } | null)?.allow_negative_stock
  );

  return (
    <Till
      branchId={activeBranch.id}
      branchName={activeBranch.name}
      cashierName={till.name}
      products={products}
      customers={tillCustomers}
      staff={staffList}
      providers={providerList}
      currencyCode={currencyCode}
      allowNegativeStock={allowNegativeStock}
      momoEnabled={Boolean(momoEnabled)}
      canOpenDrawer={Boolean(canOpenDrawer)}
    />
  );
}