import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { readTillSession } from "@/lib/auth/till-session";
import { PinPad, type TillCashier, type TillColleague } from "./pin-pad";
import { Till, type TillProduct, type TillCustomer } from "./till";

export const metadata = { title: "Till" };

interface RawVariant {
  id: string;
  sku: string | null;
  barcode: string | null;
  variant_options: Record<string, string> | null;
  selling_price: number | string;
  products: { name: string; unit_of_measure: string } | null;
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
  ] = await Promise.all([
    supabase
      .from("branches")
      .select("id, name, is_main")
      .eq("status", "active")
      .order("is_main", { ascending: false })
      .order("name"),
    supabase
      .from("product_variants")
      .select("id, sku, barcode, variant_options, selling_price, products!inner(name, unit_of_measure, status)")
      .eq("status", "active")
      .eq("products.status", "active"),
    supabase.from("customers").select("id, name, phone").eq("status", "active").order("name"),
    supabase.from("business_settings").select("pos_settings").eq("business_id", businessId).maybeSingle(),
    // One bit, not the payment settings row: a cashier cannot read that
    // table at all, and does not need to (migration 0024).
    supabase.rpc("business_momo_enabled", { p_business_id: businessId }),
  ]);

  if (branchesError) console.error("TillPage: branches query failed", branchesError);
  if (variantsError) console.error("TillPage: variants query failed", variantsError);
  if (customersError) console.error("TillPage: customers query failed", customersError);

  const activeBranch = branches?.find((b) => b.id === branch) ?? branches?.[0] ?? null;

  if (!activeBranch) {
    return (
      <p className="rounded-xl border border-neutral-200 px-3.5 py-8 text-center text-sm text-neutral-500 dark:border-neutral-800">
        No active branch to sell from. Add one under Branches first.
      </p>
    );
  }

  const { data: levels, error: levelsError } = await supabase
    .from("stock_levels")
    .select("variant_id, quantity")
    .eq("branch_id", activeBranch.id);

  if (levelsError) console.error("TillPage: stock levels query failed", levelsError);

  const onHand = new Map<string, number>(
    (levels ?? []).map((l) => [
      (l as { variant_id: string }).variant_id,
      // numeric(14,3) arrives from PostgREST as a string, not a number.
      Number((l as { quantity: number | string }).quantity),
    ])
  );

  const products: TillProduct[] = ((variants ?? []) as unknown as RawVariant[])
    .map((v) => {
      const name = v.products?.name ?? "Unknown product";
      const options = Object.entries(v.variant_options ?? {});
      const label = options.length > 0 ? `${name} — ${options.map(([, val]) => val).join(" / ")}` : name;
      return {
        variantId: v.id,
        label,
        sku: v.sku,
        barcode: v.barcode,
        price: Number(v.selling_price),
        onHand: onHand.get(v.id) ?? 0,
        unit: v.products?.unit_of_measure ?? "each",
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const tillCustomers: TillCustomer[] = (customers ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
  }));

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
      currencyCode={currencyCode}
      allowNegativeStock={allowNegativeStock}
      momoEnabled={Boolean(momoEnabled)}
    />
  );
}