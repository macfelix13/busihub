"use client";

import { useMemo, useRef, useState } from "react";
import { useFormState } from "react-dom";
import { Button, SubmitButton } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { formatQuantity } from "@/lib/validation/inventory";
import { PAYMENT_METHODS, MOMO_NETWORKS } from "@/lib/validation/sales";
import { completeSale, signOutCashier, type FormState } from "./actions";

const initialState: FormState = {};

export interface TillProduct {
  variantId: string;
  label: string;
  sku: string | null;
  barcode: string | null;
  /** numeric(14,2) from PostgREST arrives as a string; already coerced by the page. */
  price: number;
  onHand: number;
  unit: string;
  /** 'service' (braiding, sewing, barbering...) never carries stock and
   *  needs a renderer on its sale line — see migration 0040. */
  type: "product" | "service";
}

export interface TillCustomer {
  id: string;
  name: string;
  phone: string | null;
}

/** Any active staff member qualifies (no special tag/permission — see
 *  migration 0040's header) — this is who rendered the service, not who
 *  is allowed to sell it. */
export interface TillStaff {
  id: string;
  name: string;
}

interface CartLine {
  /** Client-only identity for this line — see addToCart(). Never sent to the server. */
  key: string;
  variantId: string;
  quantity: number;
  /** Only meaningful for a service line. Required by the database before checkout completes. */
  renderedBy?: string;
}

type PaymentMethod = "cash" | "credit" | "momo" | "split";

interface TillProps {
  branchId: string;
  branchName: string;
  cashierName: string;
  products: TillProduct[];
  customers: TillCustomer[];
  /** Active staff, for the "Who rendered this?" picker on a service line. */
  staff: TillStaff[];
  currencyCode: string;
  /** From pos_settings — decides whether the till warns or refuses when stock runs out. */
  allowNegativeStock: boolean;
  /** Switched on AND a Paystack account connected. Both, or the option would only fail. */
  momoEnabled: boolean;
}

export function Till({
  branchId,
  branchName,
  cashierName,
  products,
  customers,
  staff,
  currencyCode,
  allowNegativeStock,
  momoEnabled,
}: TillProps) {
  const [state, formAction] = useFormState(completeSale, initialState);
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [customerId, setCustomerId] = useState("");
  const [tendered, setTendered] = useState("");
  const [cashPart, setCashPart] = useState("");
  const [momoNumber, setMomoNumber] = useState("");
  const [momoNetwork, setMomoNetwork] = useState<string>(MOMO_NETWORKS[0].value);
  const searchRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => new Map(products.map((p) => [p.variantId, p])), [products]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    return products
      .filter(
        (p) =>
          p.label.toLowerCase().includes(q) ||
          (p.sku ?? "").toLowerCase().includes(q) ||
          (p.barcode ?? "").toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [products, query]);

  function addToCart(variantId: string) {
    const product = byId.get(variantId);
    setCart((lines) => {
      // A service line is never merged: "barber A did the braiding,
      // barber B did the dreadlocks" needs two separate lines of
      // possibly the same service, each with its own renderer — so
      // every service line is always brand new.
      if (product?.type === "service") {
        return [...lines, { key: crypto.randomUUID(), variantId, quantity: 1, renderedBy: "" }];
      }
      const existing = lines.find((l) => l.variantId === variantId);
      // Scanning the same item twice bumps the quantity rather than
      // adding a second line — which is also what the checkout schema
      // expects, since one product means one line.
      if (existing) {
        return lines.map((l) => (l.variantId === variantId ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...lines, { key: crypto.randomUUID(), variantId, quantity: 1 }];
    });
    setQuery("");
    searchRef.current?.focus();
  }

  /**
   * A barcode scanner behaves as a keyboard that types the code then
   * presses Enter. So Enter on an exact barcode/SKU match adds the item
   * straight away — that is the whole of "scanner support". Enter with a
   * single fuzzy match adds that instead, which makes typing fast too.
   */
  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = query.trim().toLowerCase();
    if (!q) return;
    const exact = products.find(
      (p) => (p.barcode ?? "").toLowerCase() === q || (p.sku ?? "").toLowerCase() === q
    );
    if (exact) {
      addToCart(exact.variantId);
      return;
    }
    // Bound to a local first: with noUncheckedIndexedAccess, narrowing an
    // indexed access across statements is not something to rely on.
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only) {
      addToCart(only.variantId);
    }
  }

  function setQuantity(key: string, quantity: number) {
    setCart((lines) =>
      quantity <= 0 ? lines.filter((l) => l.key !== key) : lines.map((l) => (l.key === key ? { ...l, quantity } : l))
    );
  }

  function setRenderedBy(key: string, staffId: string) {
    setCart((lines) => lines.map((l) => (l.key === key ? { ...l, renderedBy: staffId } : l)));
  }

  // A preview only. The database recomputes every figure from the catalog
  // when the sale is rung up — see create_sale() in migration 0020.
  const total = cart.reduce((sum, line) => {
    const product = byId.get(line.variantId);
    return sum + (product ? product.price * line.quantity : 0);
  }, 0);

  const tenderedNumber = Number(tendered);
  const change = paymentMethod === "cash" && Number.isFinite(tenderedNumber) ? tenderedNumber - total : 0;

  // The split preview. The database works out the real figure — the till
  // sends the cash and nothing else — so this is what to tell the
  // customer, not what determines the charge.
  const cashPartNumber = Number(cashPart);
  const momoPart =
    paymentMethod === "split" && Number.isFinite(cashPartNumber) ? total - cashPartNumber : total;

  // A service has no shelf to run short on — it never carries stock — so
  // it never counts toward a stock warning, only a product does.
  const shortLines = cart.filter((line) => {
    const p = byId.get(line.variantId);
    return p && p.type === "product" ? line.quantity > p.onHand : false;
  });

  // The database refuses a service line with no rendered_by anyway, but
  // catching it here means the button is disabled with an inline hint
  // instead of a rejected sale at the counter.
  const missingRenderedBy = cart.some((line) => {
    const p = byId.get(line.variantId);
    return p?.type === "service" && !line.renderedBy;
  });

  const selectedCustomer = customers.find((c) => c.id === customerId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Till</h1>
          <p className="text-neutral-500">
            {branchName} · served by <span className="font-medium">{cashierName}</span>
          </p>
        </div>
        <form action={signOutCashier}>
          <Button type="submit" variant="ghost">
            Not {cashierName}?
          </Button>
        </form>
      </div>

      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[3fr_2fr]">
        {/* ── left: find and add ── */}
        <div className="flex flex-col gap-3">
          <input
            ref={searchRef}
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Scan a barcode, or type a name or SKU…"
            className="min-h-[52px] w-full rounded-xl border border-neutral-300 bg-white px-4 py-3 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white"
          />

          {query.trim().length > 0 ? (
            <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
              <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {matches.length > 0 ? (
                  matches.map((p) => (
                    <li key={p.variantId}>
                      <button
                        type="button"
                        onClick={() => addToCart(p.variantId)}
                        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                      >
                        <span>
                          <span className="font-medium">{p.label}</span>
                          {p.type === "product" ? (
                            <span className="ml-2 text-sm text-neutral-500">
                              {formatQuantity(p.onHand)} {p.unit} left
                            </span>
                          ) : (
                            <span className="ml-2 text-sm text-neutral-500">Service</span>
                          )}
                        </span>
                        <span className="tabular-nums">{formatMoney(toMinorUnits(p.price), currencyCode)}</span>
                      </button>
                    </li>
                  ))
                ) : (
                  <li className="px-4 py-6 text-center text-sm text-neutral-500">Nothing matches that.</li>
                )}
              </ul>
            </div>
          ) : null}

          <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {cart.length > 0 ? (
                cart.map((line) => {
                  const p = byId.get(line.variantId);
                  if (!p) return null;
                  const isService = p.type === "service";
                  const short = !isService && line.quantity > p.onHand;
                  return (
                    <li key={line.key} className="flex flex-col gap-2 px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{p.label}</p>
                          <p className="text-sm text-neutral-500">
                            {formatMoney(toMinorUnits(p.price), currencyCode)} each
                            {short ? (
                              <span className="ml-2 text-red-600 dark:text-red-400">
                                only {formatQuantity(p.onHand)} in stock
                              </span>
                            ) : null}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button type="button" variant="ghost" onClick={() => setQuantity(line.key, line.quantity - 1)}>
                            −
                          </Button>
                          <span className="w-10 text-center tabular-nums">{formatQuantity(line.quantity)}</span>
                          <Button type="button" variant="ghost" onClick={() => setQuantity(line.key, line.quantity + 1)}>
                            +
                          </Button>
                        </div>
                        <span className="w-24 text-right font-medium tabular-nums">
                          {formatMoney(toMinorUnits(p.price * line.quantity), currencyCode)}
                        </span>
                      </div>
                      {isService ? (
                        <Select
                          label="Who rendered this?"
                          value={line.renderedBy ?? ""}
                          onChange={(e) => setRenderedBy(line.key, e.target.value)}
                          options={[
                            { value: "", label: "Choose a staff member…" },
                            ...staff.map((s) => ({ value: s.id, label: s.name })),
                          ]}
                        />
                      ) : null}
                    </li>
                  );
                })
              ) : (
                <li className="px-4 py-10 text-center text-sm text-neutral-500">
                  Nothing on this sale yet. Scan or search above.
                </li>
              )}
            </ul>
          </div>
        </div>

        {/* ── right: take payment ── */}
        <form action={formAction} className="flex flex-col gap-4" noValidate>
          <input type="hidden" name="branchId" value={branchId} />
          <input
            type="hidden"
            name="cartJson"
            value={JSON.stringify(
              cart.map((line) => ({
                variantId: line.variantId,
                quantity: line.quantity,
                renderedBy: line.renderedBy || undefined,
              }))
            )}
          />

          <div className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
            <div className="flex items-baseline justify-between">
              <span className="text-neutral-500">Total</span>
              <span className="text-3xl font-semibold tabular-nums">
                {formatMoney(toMinorUnits(total), currencyCode)}
              </span>
            </div>
            <p className="mt-1 text-right text-xs text-neutral-500">
              Tax included. Confirmed by the server when you take payment.
            </p>
          </div>

          <Select
            label="Payment"
            name="paymentMethod"
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
            error={state.fieldErrors?.paymentMethod}
            options={PAYMENT_METHODS.filter(
              // Offering mobile money without a connected Paystack account
              // would be a button that can only fail at the counter.
              (m) => momoEnabled || (m.value !== "momo" && m.value !== "split")
            ).map((m) => ({ value: m.value, label: m.label }))}
          />

          <Select
            label={paymentMethod === "credit" ? "Customer (required)" : "Customer (optional)"}
            name="customerId"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            error={state.fieldErrors?.customerId}
            options={[
              { value: "", label: "Walk-in" },
              ...customers.map((c) => ({ value: c.id, label: c.phone ? `${c.name} (${c.phone})` : c.name })),
            ]}
          />

          {paymentMethod === "cash" ? (
            <>
              <Field
                label={`Cash received (${currencyCode})`}
                name="amountTendered"
                type="number"
                step="0.01"
                min={0}
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                error={state.fieldErrors?.amountTendered}
              />
              <div className="flex items-baseline justify-between rounded-xl bg-neutral-100 px-3.5 py-2.5 dark:bg-neutral-800">
                <span className="text-sm text-neutral-600 dark:text-neutral-300">Change</span>
                <span
                  className={`text-lg font-semibold tabular-nums ${
                    change < 0 ? "text-red-600 dark:text-red-400" : ""
                  }`}
                >
                  {change < 0
                    ? `${formatMoney(toMinorUnits(Math.abs(change)), currencyCode)} short`
                    : formatMoney(toMinorUnits(change), currencyCode)}
                </span>
              </div>
            </>
          ) : (
            <input type="hidden" name="amountTendered" value="0" />
          )}

          {paymentMethod === "split" ? (
            <Field
              label={`Cash part (${currencyCode})`}
              name="cashAmount"
              type="number"
              step="0.01"
              min={0}
              value={cashPart}
              onChange={(e) => setCashPart(e.target.value)}
              error={state.fieldErrors?.cashAmount}
            />
          ) : (
            <input type="hidden" name="cashAmount" value="0" />
          )}

          {paymentMethod === "momo" || paymentMethod === "split" ? (
            <>
              <Field
                label="Customer's mobile money number"
                name="momoNumber"
                type="tel"
                inputMode="tel"
                placeholder="024 412 3456"
                value={momoNumber}
                onChange={(e) => setMomoNumber(e.target.value)}
                error={state.fieldErrors?.momoNumber}
              />
              <Select
                label="Network"
                name="momoNetwork"
                value={momoNetwork}
                onChange={(e) => setMomoNetwork(e.target.value)}
                error={state.fieldErrors?.momoNetwork}
                options={MOMO_NETWORKS.map((n) => ({ value: n.value, label: n.label }))}
              />
              <div className="flex items-baseline justify-between rounded-xl bg-neutral-100 px-3.5 py-2.5 dark:bg-neutral-800">
                <span className="text-sm text-neutral-600 dark:text-neutral-300">To charge their phone</span>
                <span
                  className={`text-lg font-semibold tabular-nums ${
                    momoPart <= 0 ? "text-red-600 dark:text-red-400" : ""
                  }`}
                >
                  {formatMoney(toMinorUnits(Math.max(momoPart, 0)), currencyCode)}
                </span>
              </div>
              <p className="text-sm text-neutral-500">
                They approve it on their own phone and have about three minutes. The sale stays open until they do.
              </p>
            </>
          ) : null}

          {paymentMethod === "credit" && selectedCustomer ? (
            <p className="text-sm text-neutral-500">
              This will be added to {selectedCustomer.name}&apos;s account. It is refused if it takes them over their
              credit limit.
            </p>
          ) : null}

          {shortLines.length > 0 ? (
            <p
              className={`rounded-xl px-3.5 py-2.5 text-sm ${
                allowNegativeStock
                  ? "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                  : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
              }`}
            >
              {allowNegativeStock
                ? "Some items are short on stock. The sale will go through and the stock will show as negative until you count it."
                : "Some items are short on stock, so this sale will be refused. Adjust the quantity, or record a stock count first."}
            </p>
          ) : null}

          {missingRenderedBy ? (
            <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              Choose who rendered each service before taking payment.
            </p>
          ) : null}

          <SubmitButton
            pendingText="Taking payment…"
            className="min-h-[52px] text-base"
            disabled={cart.length === 0 || missingRenderedBy}
          >
            {paymentMethod === "cash"
              ? "Take cash"
              : paymentMethod === "credit"
                ? "Put on account"
                : paymentMethod === "momo"
                  ? "Prompt their phone"
                  : "Take cash and prompt"}
          </SubmitButton>

          {cart.length > 0 ? (
            <Button type="button" variant="ghost" onClick={() => setCart([])}>
              Clear sale
            </Button>
          ) : null}
        </form>
      </div>
    </div>
  );
}