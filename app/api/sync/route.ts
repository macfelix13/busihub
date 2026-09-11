import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requirePermission, AuthorizationError } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getCurrentBusinessId, NoBusinessError } from "@/lib/auth/current-business";
import { syncRequestSchema } from "@/lib/validation/offline-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SyncResult =
  | { clientTransactionId: string; status: "ok"; saleId: string }
  | { clientTransactionId: string; status: "error"; error: string };

/**
 * Where a queued offline sale actually lands (Phase 17, migration 0052).
 *
 * This is the backend half of offline sync only — there is no service
 * worker or IndexedDB outbox calling this yet; that client-side queue is
 * separate follow-up work. What exists here is the endpoint that queue
 * will eventually POST to, built and tested first so the database layer
 * it depends on is proven before any client code is written against it.
 *
 * Three things this handler is careful about, matching the standing
 * rules for every Route Handler that mutates tenant data:
 *
 *   1. Authenticated the ordinary way. This uses the caller's own
 *      session (createServerSupabaseClient — never the service role), so
 *      every insert this triggers still goes through create_sale()'s own
 *      RLS-scoped inserts exactly as if it had been rung up live at the
 *      till. Nothing here is trusted just because it arrived at this
 *      endpoint instead of the till's Server Action.
 *
 *   2. requirePermission() is called up front (sales.process on the
 *      caller's own business) as the same defense-in-depth every other
 *      Server Action/Route Handler applies — RLS would refuse an
 *      unauthorized insert anyway, but this returns a clean 403 instead
 *      of the batch failing item-by-item with raw Postgres errors.
 *
 *   3. Payment method is restricted to cash/credit before create_sale is
 *      ever called (see lib/validation/offline-sync.ts) — the database
 *      refuses mobile money for a synced sale too (0052), so this is
 *      belt-and-suspenders, not the only gate.
 *
 * Each queued sale is processed independently: one bad item in the batch
 * (insufficient permission on its particular branch, a since-deleted
 * customer, whatever) fails only that item and returns a per-item error,
 * so the caller's outbox can clear everything that DID land and retry or
 * surface only the ones that did not. There is no reason to fail the
 * whole batch for one bad line — that would leave sales that succeeded
 * offline stuck in the queue behind one that never will.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const parsed = syncRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "One or more queued sales could not be read.",
        issues: parsed.error.issues.map((issue) => issue.message),
      },
      { status: 400 }
    );
  }

  const supabase = await createServerSupabaseClient();

  let businessId: string;
  try {
    businessId = await getCurrentBusinessId(supabase);
    await requirePermission(supabase, businessId, PERMISSIONS.SALES_PROCESS);
  } catch (err) {
    if (err instanceof AuthorizationError || err instanceof NoBusinessError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    console.error("POST /api/sync: permission/business lookup failed", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  const results: SyncResult[] = [];

  // One at a time, not in parallel: several queued sales can legitimately
  // touch the same variant's stock, and running them concurrently would
  // just race each other inside apply_inventory_movement()'s
  // read-modify-write for no benefit — a sync batch is not on anyone's
  // critical path the way the live till is, so there is nothing to gain
  // by overlapping these round trips.
  for (const sale of parsed.data.sales) {
    const { data: saleId, error } = await supabase.rpc("create_sale", {
      p_branch_id: sale.branchId,
      p_cashier_id: null,
      p_customer_id: sale.customerId || null,
      p_payment_method: sale.paymentMethod,
      p_amount_tendered: sale.paymentMethod === "cash" ? sale.amountTendered : 0,
      p_items: sale.items.map((line) => ({
        variant_id: line.variantId,
        quantity: line.quantity,
        rendered_by: line.renderedByStaffId || null,
        provider_id: line.renderedByProviderId || null,
      })),
      p_payments: null,
      p_client_transaction_id: sale.clientTransactionId,
    });

    if (error) {
      console.error("POST /api/sync: create_sale failed", {
        clientTransactionId: sale.clientTransactionId,
        error,
      });
      // Same mapping the till's completeSale uses: the database's P0001
      // messages are already written for a person to read ("Not enough
      // stock", "Mobile money is not available for a sale synced from
      // offline"), everything else collapses to a generic message so no
      // raw Postgres detail reaches the client.
      let message = "Couldn't sync this sale. Please try again.";
      if (error.code === "P0001" && error.message) {
        message = error.message;
      } else if (error.code === "P0002") {
        message = "A product, branch or customer on this sale could not be found.";
      } else if (error.code === "42501") {
        message = "You don't have permission to sync this sale.";
      } else if (error.code === "22023") {
        message = "Unknown payment method.";
      }
      results.push({ clientTransactionId: sale.clientTransactionId, status: "error" as const, error: message });
      continue;
    }

    results.push({
      clientTransactionId: sale.clientTransactionId,
      status: "ok" as const,
      saleId: saleId as string,
    });
  }

  return NextResponse.json({ results });
}