"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId } from "@/lib/auth/current-business";
import { startTillSession, endTillSession } from "@/lib/auth/till-session";
import { assertValidPinFormat, InvalidPinFormatError } from "@/lib/auth/pin";
import { checkoutSchema, normaliseMomoNumber } from "@/lib/validation/sales";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { loadPaystackCredentials, chargeMobileMoney, type MomoNetwork } from "@/lib/paystack/client";
import { zodFieldErrors } from "@/lib/validation/zod-helpers";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Confirms it's really you. The PIN is verified inside the database
 * (migration 0039) against the CALLER's own profile only — there is no
 * parameter here to name anyone else, by design, so this can never be
 * used to sign in "as" a colleague. The hash is never readable by any
 * client, and the lockout counter is maintained in the same call, so an
 * attacker cannot decline to report their own failures.
 */
export async function verifyOwnPin(_prevState: FormState, formData: FormData): Promise<FormState> {
  const pin = String(formData.get("pin") ?? "");

  try {
    assertValidPinFormat(pin);
  } catch (err) {
    if (err instanceof InvalidPinFormatError) {
      return { error: "Enter your 4 to 6 digit PIN.", fieldErrors: { pin: err.message } };
    }
    throw err;
  }

  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You're not signed in. Please log in again." };
  }

  const { data: ok, error } = await supabase.rpc("verify_profile_pin", { p_pin: pin });

  if (error) {
    console.error("verifyOwnPin: rpc failed", error);
    // P0001 here is a message written for the user — locked out, no PIN
    // set, or not active — and is worth showing verbatim.
    if (error.code === "P0001" && error.message) {
      return { error: error.message };
    }
    return { error: "Couldn't check that PIN. Please try again." };
  }

  if (!ok) {
    return { error: "That PIN isn't right.", fieldErrors: { pin: "Incorrect PIN." } };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("first_name, last_name")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    console.error("verifyOwnPin: own-profile lookup failed", profileError);
  }

  const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || "You";

  await startTillSession(user.id, name);

  revalidatePath("/till");
  redirect("/till");
}

/**
 * Hands the till to a colleague. Deliberately their PASSWORD, not a PIN —
 * this actually re-authenticates the browser as them (the same
 * `signInWithPassword` call the login page uses), so the till's identity
 * always matches a real Supabase login rather than a name someone picked
 * from a list (0039). Ending the till session first means the incoming
 * account can never inherit whatever unlock the outgoing one had.
 */
export async function switchTillUser(_prevState: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email) {
    return { error: "That account has no email on file, so it can't sign in here." };
  }
  if (!password) {
    return { error: "Enter their password.", fieldErrors: { password: "Required." } };
  }

  const supabase = await createServerSupabaseClient();

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Same generic message as the real login page, for the same reason —
    // do not reveal whether the password (or the account) was the
    // problem. Logged server-side so this is diagnosable during testing.
    console.error("switchTillUser: signInWithPassword failed", {
      status: error.status,
      name: error.name,
      message: error.message,
    });
    return { error: "Incorrect email or password.", fieldErrors: { password: "Incorrect." } };
  }

  await endTillSession();

  revalidatePath("/till");
  redirect("/till");
}

/** Locks the till. Whoever's still signed in can unlock it again with their own PIN, or switch to someone else. */
export async function signOutCashier(): Promise<void> {
  await endTillSession();
  revalidatePath("/till");
  redirect("/till");
}

/**
 * Rings up the sale.
 *
 * Note what is NOT sent: prices, tax, or totals. create_sale() takes only
 * variant ids, quantities and tenders, and derives the money itself from
 * the catalog and the business's tax settings. The cart's figures are a
 * preview for the person at the counter; the receipt is whatever the
 * database calculated.
 *
 * With mobile money there is a second step, and the order matters. The
 * sale is created FIRST — which commits the stock and produces the
 * reference Paystack will quote back — and only then is the customer's
 * phone prompted. Charging first would mean holding a successful payment
 * with nothing to attach it to.
 */
export async function completeSale(_prevState: FormState, formData: FormData): Promise<FormState> {
  const raw = formData.get("cartJson");
  let items: unknown = [];
  if (typeof raw === "string" && raw.length > 0) {
    try {
      items = JSON.parse(raw);
    } catch {
      return { error: "Something went wrong with the cart. Please try again." };
    }
  }

  const parsed = checkoutSchema.safeParse({
    branchId: formData.get("branchId"),
    customerId: formData.get("customerId"),
    paymentMethod: formData.get("paymentMethod"),
    amountTendered: formData.get("amountTendered"),
    cashAmount: formData.get("cashAmount"),
    momoNumber: formData.get("momoNumber"),
    momoNetwork: formData.get("momoNetwork"),
    items,
  });

  if (!parsed.success) {
    const fieldErrors = zodFieldErrors(parsed.error);
    return { error: fieldErrors.items ?? "Please fix the errors below.", fieldErrors };
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await getCurrentBusinessId(supabase);
    await requirePermission(supabase, businessId, PERMISSIONS.SALES_PROCESS);
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: err.message };
    console.error("completeSale: permission/business lookup failed", err);
    return { error: "Something went wrong. Please try again." };
  }

  // The cashier is never taken from the form: create_sale() (0039) always
  // attributes the sale to whoever's actual Supabase session is calling
  // it, so there is nothing to read from the till cookie for this anymore.
  const {
    branchId,
    customerId,
    paymentMethod,
    amountTendered,
    cashAmount,
    momoNumber,
    momoNetwork,
    items: lines,
  } = parsed.data;

  const wantsMomo = paymentMethod === "momo" || paymentMethod === "split";

  // Refuse before creating anything if the shop cannot actually take it.
  // The alternative is a sale that commits stock and then discovers there
  // is no Paystack account to charge.
  const credentials = wantsMomo ? await loadPaystackCredentials(businessId) : null;
  if (wantsMomo && (!credentials || !credentials.momoEnabled)) {
    return {
      error: credentials
        ? "Mobile money is switched off for this shop. An owner can turn it on in Settings → Payments."
        : "This shop hasn't connected a Paystack account yet. An owner can do that in Settings → Payments.",
    };
  }

  // The tenders, in the shape create_sale expects. Cash is what was
  // handed over; everything else is exact.
  const payments: Record<string, unknown>[] = [];
  if (paymentMethod === "cash") {
    payments.push({ method: "cash", amount: amountTendered });
  } else if (paymentMethod === "credit") {
    payments.push({ method: "credit" });
  } else {
    if (paymentMethod === "split") {
      payments.push({ method: "cash", amount: cashAmount });
    }
    payments.push({
      // No `amount` key AT ALL, deliberately: create_sale works out what
      // is left to charge after the cash, so the till cannot ask for a
      // different figure than the sale is worth.
      //
      // Note it is omitted rather than set to null. `JSON.stringify`
      // writes an explicit `"amount": null`, and in PostgreSQL
      // `jsonb -> 'amount'` is SQL NULL only for an ABSENT key — an
      // explicit null is the jsonb value `null`, which is not SQL NULL.
      // Sending null therefore missed the branch entirely and every
      // mobile money sale was refused. 0025 now accepts both spellings;
      // this sends the unambiguous one.
      method: "momo",
      momo_number: normaliseMomoNumber(momoNumber ?? ""),
      momo_network: momoNetwork,
    });
  }

  const { data: saleId, error } = await supabase.rpc("create_sale", {
    p_branch_id: branchId,
    p_cashier_id: null,
    p_customer_id: customerId || null,
    p_payment_method: paymentMethod,
    p_amount_tendered: paymentMethod === "cash" ? amountTendered : 0,
    p_items: lines.map((line) => ({ variant_id: line.variantId, quantity: line.quantity })),
    p_payments: payments,
  });

  if (error) {
    console.error("completeSale: rpc failed", error);
    // The database's messages here are written for a person at a counter
    // — "Not enough stock", "over their credit limit", "Not enough cash
    // tendered" — and each names something they can act on.
    if (error.code === "P0001" && error.message) {
      return { error: error.message };
    }
    if (error.code === "P0002") {
      return { error: "A product, branch or customer on this sale could not be found." };
    }
    if (error.code === "42501") {
      return { error: "You don't have permission to complete a sale." };
    }
    return { error: "Couldn't complete the sale. Please try again." };
  }

  const sale = saleId as string;

  if (wantsMomo && credentials) {
    const failure = await promptCustomerPhone(supabase, businessId, sale, credentials);
    if (failure) {
      // Nothing was charged, so the sale should not linger holding stock.
      // Returning the error (rather than redirecting) also keeps the cart
      // on screen, so the cashier can fix the number and try again.
      const { error: cancelError } = await supabase.rpc("cancel_unpaid_sale", {
        p_sale_id: sale,
        p_reason: "Mobile money charge could not be started",
      });
      if (cancelError) {
        console.error("completeSale: could not cancel after a failed charge", cancelError);
        // The sale is still holding stock and is visible at /sales/[id],
        // where it can be cancelled by hand. Say so rather than implying
        // nothing happened.
        return { error: `${failure} The sale is waiting on receipt ${sale} and should be cancelled there.` };
      }
      revalidatePath("/inventory");
      return { error: failure };
    }
  }

  revalidatePath("/till");
  revalidatePath("/inventory");
  redirect(`/sales/${sale}`);
}

/**
 * Asks Paystack to prompt the customer's phone for the pending tender on
 * this sale. Returns null on success, or a message for the counter.
 *
 * The amount is read back from the payment row rather than taken from the
 * form: the database decided what was left to charge after any cash, and
 * that is the only figure allowed to reach Paystack.
 */
async function promptCustomerPhone(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  businessId: string,
  saleId: string,
  credentials: NonNullable<Awaited<ReturnType<typeof loadPaystackCredentials>>>
): Promise<string | null> {
  const { data, error } = await supabase
    .from("sale_payments")
    .select("id, amount, momo_number, momo_network")
    .eq("sale_id", saleId)
    .eq("method", "momo")
    .maybeSingle();

  const payment = data as {
    id: string;
    amount: number | string;
    momo_number: string | null;
    momo_network: string | null;
  } | null;

  if (error || !payment) {
    console.error("promptCustomerPhone: could not read the pending tender", error);
    return "The sale was recorded but the mobile money prompt could not be started.";
  }

  if (!payment.momo_number || !payment.momo_network) {
    return "That sale has no mobile money number to prompt.";
  }

  // Paystack requires an email on a charge. It is the shop's, not the
  // customer's: a walk-in has no email, and inventing one per customer
  // would scatter meaningless records through their Paystack dashboard.
  const { data: business } = await supabase.from("businesses").select("email").eq("id", businessId).maybeSingle();
  const email = (business as { email: string | null } | null)?.email ?? "pos@busihub.app";

  const result = await chargeMobileMoney({
    credentials,
    email,
    amount: Number(payment.amount),
    reference: payment.id,
    phone: payment.momo_number,
    network: payment.momo_network as MomoNetwork,
  });

  if (!result.ok) {
    return result.message ?? "Paystack refused that charge.";
  }

  if (result.status === "failed") {
    // Paystack answered immediately and said no.
    const admin = createServiceRoleClient();
    await admin.rpc("settle_sale_payment", {
      p_business_id: businessId,
      p_payment_id: payment.id,
      p_status: "failed",
      p_provider_charge_id: result.chargeId,
      p_failure_reason: result.message ?? "Charge declined",
    });
    return result.message ?? "That charge was declined.";
  }

  return null;
}