"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useFormState } from "react-dom";
import { AlertCircle, Minus, Plus } from "lucide-react";
import { Button, SubmitButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { BarcodeScannerModal } from "@/components/ui/barcode-scanner-modal";
import { ProductThumbnail } from "@/components/ui/product-thumbnail";
import { formatMoney, toMinorUnits } from "@/lib/money/money";
import { formatQuantity } from "@/lib/validation/inventory";
import { PAYMENT_METHODS, MOMO_NETWORKS, normaliseMomoNumber, guessMomoNetwork } from "@/lib/validation/sales";
import { useOnlineStatus } from "@/lib/offline/use-online-status";
import { enqueueSale } from "@/lib/offline/queue";
import { completeSale, signOutCashier, openDrawerNoSale, type FormState } from "./actions";

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
  /** Cosmetic only (migration 0041) — does not affect pricing or checkout. */
  durationMinutes: number | null;
  /** Already resolved to a short-lived signed URL by the page (migration
   *  0046). Null means no photo — ProductThumbnail shows a plain fallback
   *  icon in that case. */
  photoUrl: string | null;
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

/** The second renderer pool (migration 0045): staff who render a service
 *  but never sign in — a barber, a nail tech. Already scoped to THIS
 *  branch by the page (unlike TillStaff, which is business-wide) — a
 *  service provider tied to a different branch never reaches this list. */
export interface TillProvider {
  id: string;
  name: string;
  title: string | null;
}

/** Encodes which of the two renderer pools a cart line's choice came
 *  from, so the till never has to compare a profiles.id against a
 *  service_providers.id as if they were one id space. */
type RendererChoice = { kind: "staff" | "provider"; id: string };

function encodeRenderer(choice: RendererChoice): string {
  return `${choice.kind}:${choice.id}`;
}

function decodeRenderer(value: string | undefined): RendererChoice | null {
  if (!value) return null;
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if ((kind !== "staff" && kind !== "provider") || !id) return null;
  return { kind, id };
}

interface CartLine {
  /** Client-only identity for this line — see addToCart(). Never sent to the server. */
  key: string;
  variantId: string;
  quantity: number;
  /** Only meaningful for a service line. Encodes which pool the choice
   *  came from (see encodeRenderer/decodeRenderer) — required by the
   *  database before checkout completes. */
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
  /** Active service providers AT THIS BRANCH (migration 0045), merged
   *  into the same picker alongside staff. */
  providers: TillProvider[];
  currencyCode: string;
  /** From pos_settings — decides whether the till warns or refuses when stock runs out. */
  allowNegativeStock: boolean;
  /** Switched on AND a Paystack account connected. Both, or the option would only fail. */
  momoEnabled: boolean;
  /** sales.no_sale (migration 0044) — cosmetic gate for showing the "No sale" button; openDrawerNoSale() re-checks this itself. */
  canOpenDrawer: boolean;
}

export function Till({
  branchId,
  branchName,
  cashierName,
  products,
  customers,
  staff,
  providers,
  currencyCode,
  allowNegativeStock,
  momoEnabled,
  canOpenDrawer,
}: TillProps) {
  const [state, formAction] = useFormState(completeSale, initialState);
  const isOnline = useOnlineStatus();
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [customerId, setCustomerId] = useState("");
  const [tendered, setTendered] = useState("");
  const [cashPart, setCashPart] = useState("");
  const [momoNumber, setMomoNumber] = useState("");
  // Phase 17 (Synchronization), client half — "mid-session resilience"
  // only (see docs/ARCHITECTURE.md): if the connection drops while this
  // page is already open, a cash/credit sale queues locally instead of
  // being refused outright. Reopening /till from a cold start still needs
  // a live connection, exactly as before — nothing here changes that.
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queuedConfirmation, setQueuedConfirmation] = useState<{
    itemCount: number;
    total: number;
    paymentMethod: "cash" | "credit";
    change: number | null;
  } | null>(null);
  // How much of each variant THIS TAB has already queued this session but
  // not yet synced — subtracted from the server-reported onHand for
  // display and the short-stock check, so ringing up several offline
  // sales in a row doesn't keep showing stock that's already spoken for.
  // Deliberately per-tab, not a real reservation: another till, or this
  // same one after a reload, has no way to know about it, and the server
  // itself still allows a synced sale to oversell rather than refuse it
  // (0052) — this is a courtesy display, not a correctness guarantee.
  const [queuedThisSession, setQueuedThisSession] = useState<Record<string, number>>({});
  const [momoNetwork, setMomoNetwork] = useState<string>(MOMO_NETWORKS[0].value);
  // Whether the cashier has explicitly picked a network for THIS number,
  // as opposed to it still being wherever guessMomoNetwork() (or the
  // plain default) last left it. Once true, typing in the phone number
  // field stops overriding their choice — this is what makes the
  // auto-select below a convenience rather than something fighting a
  // deliberate override (e.g. a number ported to a different network).
  const [momoNetworkTouched, setMomoNetworkTouched] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [noSaleOpen, setNoSaleOpen] = useState(false);
  const [noSaleReason, setNoSaleReason] = useState("");
  const [noSaleError, setNoSaleError] = useState<string | null>(null);
  const [noSaleSlip, setNoSaleSlip] = useState<string | null>(null);
  const [noSalePending, startNoSaleTransition] = useTransition();

  const byId = useMemo(() => new Map(products.map((p) => [p.variantId, p])), [products]);

  function adjustedOnHand(p: TillProduct): number {
    return p.onHand - (queuedThisSession[p.variantId] ?? 0);
  }

  // Mobile money can't be prompted for a charge that already happened by
  // the time a connection returns (0052 refuses it server-side too for a
  // synced sale), so a selection made while online is no longer valid the
  // moment the connection drops mid-session.
  //
  // The setState is deferred a tick (rather than called straight in the
  // effect body) so this doesn't trip react-hooks/set-state-in-effect: a
  // direct, synchronous setState here would force a second render in the
  // same commit as the isOnline flip. Letting the browser reach idle
  // first, then applying the reset, is the same one-line-of-lag fix the
  // rule's own docs point at — imperceptible here since going offline is
  // itself an async, user-visible event, not something rendered mid-frame.
  useEffect(() => {
    if (!isOnline && (paymentMethod === "momo" || paymentMethod === "split")) {
      const timeoutId = setTimeout(() => setPaymentMethod("cash"), 0);
      return () => clearTimeout(timeoutId);
    }
  }, [isOnline, paymentMethod]);

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
   * Exact barcode/SKU match, shared by every scanning input this till
   * has: a USB/Bluetooth scanner (which behaves as a keyboard typing the
   * code then Enter — see onSearchKeyDown below) and the phone-camera
   * scanner (BarcodeScannerModal), which hands a decoded string straight
   * to this same function. One matching rule for "found it" means the
   * two input methods can never quietly disagree about what a code means.
   */
  function tryAddByBarcode(code: string): boolean {
    const q = code.trim().toLowerCase();
    if (!q) return false;
    const exact = products.find(
      (p) => (p.barcode ?? "").toLowerCase() === q || (p.sku ?? "").toLowerCase() === q
    );
    if (!exact) return false;
    addToCart(exact.variantId);
    return true;
  }

  function onScanned(code: string) {
    setScannerOpen(false);
    if (!tryAddByBarcode(code)) {
      setScanError(`Nothing matches "${code}".`);
      window.setTimeout(() => setScanError(null), 4000);
    }
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
    const q = query.trim();
    if (!q) return;
    if (tryAddByBarcode(q)) return;
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

  function setRenderedBy(key: string, encoded: string) {
    setCart((lines) => lines.map((l) => (l.key === key ? { ...l, renderedBy: encoded } : l)));
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
    return p && p.type === "product" ? line.quantity > adjustedOnHand(p) : false;
  });

  // The database refuses a service line with no rendered_by anyway, but
  // catching it here means the button is disabled with an inline hint
  // instead of a rejected sale at the counter.
  const missingRenderedBy = cart.some((line) => {
    const p = byId.get(line.variantId);
    return p?.type === "service" && !line.renderedBy;
  });

  const selectedCustomer = customers.find((c) => c.id === customerId);

  /**
   * The offline path. Left untouched (no onSubmit at all, `<form
   * action={formAction}>` submits exactly as before) whenever the
   * browser reports it's online — this function's whole body only runs
   * once there is genuinely no connection to try the server with.
   *
   * There is no server round trip here to validate anything, so the two
   * checks below (payment method, credit needs a customer) are the real
   * gate for this path — the UI already steers around both (the Payment
   * picker hides momo/split while offline, and nothing disables the
   * customer field for credit) but neither is trusted alone, the same
   * way the till never trusts its own disabled-button state as the only
   * thing stopping a bad submission.
   */
  function handleOfflineSubmit(e: React.FormEvent<HTMLFormElement>) {
    if (isOnline) return;
    e.preventDefault();
    setQueueError(null);

    if (cart.length === 0 || missingRenderedBy) return;

    if (paymentMethod !== "cash" && paymentMethod !== "credit") {
      setQueueError("Only cash or on-account sales can be taken while offline.");
      return;
    }
    if (paymentMethod === "credit" && !customerId) {
      setQueueError("Choose a customer to put this sale on account while offline.");
      return;
    }
    // create_sale() still checks this for a synced sale exactly as it
    // does online (0052 only exempts the stock and mobile-money checks
    // for reason = sale_synced) — with no server round trip to catch it
    // now, a short cash tender would otherwise sit in the queue and only
    // fail once it finally reaches the server.
    if (paymentMethod === "cash" && !(tenderedNumber >= total)) {
      setQueueError("Not enough cash tendered.");
      return;
    }

    // Captured as its own binding, typed to just the two offline-eligible
    // methods, rather than relying on the checks above to keep narrowing
    // `paymentMethod` itself all the way into the .then() callback below.
    const offlinePaymentMethod: "cash" | "credit" = paymentMethod === "credit" ? "credit" : "cash";
    const itemCount = cart.reduce((n, line) => n + line.quantity, 0);
    const saleTotal = total;
    const saleChange = offlinePaymentMethod === "cash" ? change : null;

    enqueueSale({
      clientTransactionId: crypto.randomUUID(),
      branchId,
      customerId: customerId || undefined,
      paymentMethod: offlinePaymentMethod,
      amountTendered: offlinePaymentMethod === "cash" ? tenderedNumber : 0,
      items: cart.map((line) => {
        const renderer = decodeRenderer(line.renderedBy);
        return {
          variantId: line.variantId,
          quantity: line.quantity,
          renderedByStaffId: renderer?.kind === "staff" ? renderer.id : undefined,
          renderedByProviderId: renderer?.kind === "provider" ? renderer.id : undefined,
        };
      }),
      queuedAt: new Date().toISOString(),
      summary: { itemCount, total: saleTotal, branchName, cashierName },
    })
      .then(() => {
        setQueuedThisSession((prev) => {
          const next = { ...prev };
          for (const line of cart) {
            next[line.variantId] = (next[line.variantId] ?? 0) + line.quantity;
          }
          return next;
        });
        setQueuedConfirmation({ itemCount, total: saleTotal, paymentMethod: offlinePaymentMethod, change: saleChange });
        setCart([]);
        setTendered("");
        setCustomerId("");
      })
      .catch((err) => {
        console.error("Till: could not queue offline sale", err);
        setQueueError("Couldn't save this sale for later on this device. Please try again.");
      });
  }

  return (
    <>
    <div className="flex flex-col gap-6 print:hidden">
      <PageHeader
        title="Till"
        description={
          <>
            {branchName} · served by <span className="font-medium">{cashierName}</span>
          </>
        }
        actions={
          <>
            {canOpenDrawer ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setNoSaleReason("");
                  setNoSaleError(null);
                  setNoSaleSlip(null);
                  setNoSaleOpen(true);
                }}
              >
                No sale
              </Button>
            ) : null}
            <form action={signOutCashier}>
              <Button type="submit" variant="ghost">
                Not {cashierName}?
              </Button>
            </form>
          </>
        }
      />

      {state.error || queueError ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span>{state.error || queueError}</span>
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[3fr_2fr]">
        {/* ── left: find and add ── */}
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              ref={searchRef}
              autoFocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Scan a barcode, or type a name or SKU…"
              className="min-h-[52px] w-full flex-1 rounded-xl border border-neutral-300 bg-white px-4 py-3 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white"
            />
            {/* Camera-based scanning — for a till running on a phone/tablet
                with no USB/Bluetooth scanner attached. That hardware kind
                already works through the search box above (it types a code
                then presses Enter, same as a keyboard). */}
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setScanError(null);
                setScannerOpen(true);
              }}
              className="min-h-[52px] shrink-0"
            >
              Scan
            </Button>
          </div>
          {scanError ? <p className="text-sm text-red-600 dark:text-red-400">{scanError}</p> : null}

          {query.trim().length > 0 ? (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {matches.length > 0 ? (
                  matches.map((p) => (
                    <li key={p.variantId}>
                      <button
                        type="button"
                        onClick={() => addToCart(p.variantId)}
                        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                      >
                        <span className="flex items-center gap-3">
                          <ProductThumbnail photoUrl={p.photoUrl} size="sm" />
                          <span>
                            <span className="font-medium">{p.label}</span>
                            {p.type === "product" ? (
                              <span className="ml-2 text-sm text-neutral-500">
                                {formatQuantity(adjustedOnHand(p))} {p.unit} left
                              </span>
                            ) : (
                              <span className="ml-2 text-sm text-neutral-500">
                                Service{p.durationMinutes ? ` · ${p.durationMinutes} min` : ""}
                              </span>
                            )}
                          </span>
                        </span>
                        <span className="tabular-nums">{formatMoney(toMinorUnits(p.price), currencyCode)}</span>
                      </button>
                    </li>
                  ))
                ) : (
                  <li className="px-4 py-6 text-center text-sm text-neutral-500">Nothing matches that.</li>
                )}
              </ul>
            </Card>
          ) : products.length > 0 ? (
            // Browsable by default — not just reachable by typing. Every
            // product/service here already passed the server's own
            // available_at_till + active filter (migration 0043), so
            // nothing extra to gate here; tapping a tile is identical to
            // picking a search match below.
            <Card className="max-h-[28rem] overflow-y-auto p-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {products.map((p) => (
                  <button
                    key={p.variantId}
                    type="button"
                    onClick={() => addToCart(p.variantId)}
                    className="flex flex-col items-start gap-1.5 rounded-xl border border-neutral-200 px-3 py-2.5 text-left transition-colors hover:border-brand-500 hover:bg-brand-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50"
                  >
                    <ProductThumbnail photoUrl={p.photoUrl} size="sm" />
                    <span className="line-clamp-2 text-sm font-medium leading-tight">{p.label}</span>
                    <span className="text-xs text-neutral-500">
                      {p.type === "product"
                        ? `${formatQuantity(adjustedOnHand(p))} ${p.unit} left`
                        : `Service${p.durationMinutes ? ` · ${p.durationMinutes} min` : ""}`}
                    </span>
                    <span className="tabular-nums text-sm font-medium">
                      {formatMoney(toMinorUnits(p.price), currencyCode)}
                    </span>
                  </button>
                ))}
              </div>
            </Card>
          ) : (
            <p className="rounded-2xl border border-neutral-200 px-4 py-6 text-center text-sm text-neutral-500 dark:border-neutral-800">
              Nothing is set to show at the till yet. Turn on &ldquo;Show at till&rdquo; from a product or
              service&apos;s page.
            </p>
          )}

          <Card className="overflow-hidden">
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {cart.length > 0 ? (
                cart.map((line) => {
                  const p = byId.get(line.variantId);
                  if (!p) return null;
                  const isService = p.type === "service";
                  const short = !isService && line.quantity > adjustedOnHand(p);
                  return (
                    <li key={line.key} className="flex flex-col gap-2 px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{p.label}</p>
                          <p className="text-sm text-neutral-500">
                            {formatMoney(toMinorUnits(p.price), currencyCode)} each
                            {isService && p.durationMinutes ? ` · ${p.durationMinutes} min` : ""}
                            {short ? (
                              <span className="ml-2 text-red-600 dark:text-red-400">
                                only {formatQuantity(adjustedOnHand(p))} in stock
                              </span>
                            ) : null}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            aria-label="Decrease quantity"
                            onClick={() => setQuantity(line.key, line.quantity - 1)}
                          >
                            <Minus className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          <span className="w-10 text-center tabular-nums">{formatQuantity(line.quantity)}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            aria-label="Increase quantity"
                            onClick={() => setQuantity(line.key, line.quantity + 1)}
                          >
                            <Plus className="h-4 w-4" aria-hidden="true" />
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
                            { value: "", label: "Choose who rendered this…" },
                            // Two pools (migration 0045), merged into one
                            // list — a real staff account and a no-login
                            // service provider are equally valid answers
                            // to "who did the work"; encodeRenderer keeps
                            // their ids from ever being compared as if
                            // they were the same id space.
                            ...staff.map((s) => ({
                              value: encodeRenderer({ kind: "staff", id: s.id }),
                              label: s.name,
                            })),
                            ...providers.map((p) => ({
                              value: encodeRenderer({ kind: "provider", id: p.id }),
                              label: p.title ? `${p.name} — ${p.title}` : p.name,
                            })),
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
          </Card>
        </div>

        {/* ── right: take payment ── */}
        {queuedConfirmation ? (
          // The offline equivalent of completeSale()'s redirect to
          // /sales/[id]: there is no receipt page to send anyone to yet
          // (the sale doesn't exist server-side until this syncs), so
          // this stands in as "you're done, here's what happened" until
          // "New sale" clears it and starts the next one.
          <Card className="flex flex-col gap-3 p-5">
            <p className="text-lg font-semibold">
              Sale queued — {formatMoney(toMinorUnits(queuedConfirmation.total), currencyCode)}
            </p>
            <p className="text-sm text-neutral-600 dark:text-neutral-300">
              {queuedConfirmation.itemCount} item{queuedConfirmation.itemCount === 1 ? "" : "s"} ·{" "}
              {queuedConfirmation.paymentMethod === "cash" ? "Cash" : "On account"}
              {queuedConfirmation.change !== null
                ? ` · Change ${formatMoney(toMinorUnits(queuedConfirmation.change), currencyCode)}`
                : ""}
            </p>
            <p className="text-sm text-neutral-500">
              Saved on this device — there&apos;s no receipt number yet. It will sync automatically once you&apos;re
              back online, or you can watch it from the banner at the bottom of the screen.
            </p>
            <Button type="button" onClick={() => setQueuedConfirmation(null)}>
              New sale
            </Button>
          </Card>
        ) : (
        <form action={formAction} onSubmit={handleOfflineSubmit} className="flex flex-col gap-4" noValidate>
          <input type="hidden" name="branchId" value={branchId} />
          <input
            type="hidden"
            name="cartJson"
            value={JSON.stringify(
              cart.map((line) => {
                const renderer = decodeRenderer(line.renderedBy);
                return {
                  variantId: line.variantId,
                  quantity: line.quantity,
                  renderedByStaffId: renderer?.kind === "staff" ? renderer.id : undefined,
                  renderedByProviderId: renderer?.kind === "provider" ? renderer.id : undefined,
                };
              })
            )}
          />

          <Card className="p-5">
            <div className="flex items-baseline justify-between">
              <span className="text-neutral-500">Total</span>
              <span className="text-3xl font-semibold tabular-nums">
                {formatMoney(toMinorUnits(total), currencyCode)}
              </span>
            </div>
            <p className="mt-1 text-right text-xs text-neutral-500">
              Tax included. Confirmed by the server when you take payment.
            </p>
          </Card>

          {!isOnline ? (
            <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              You&apos;re offline. Cash and on-account sales are still saved here and sync automatically once you
              reconnect — mobile money isn&apos;t available until then.
            </p>
          ) : null}

          <Select
            label="Payment"
            name="paymentMethod"
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
            error={state.fieldErrors?.paymentMethod}
            options={PAYMENT_METHODS.filter(
              // Offering mobile money without a connected Paystack account
              // would be a button that can only fail at the counter — and
              // so would offering it with no connection at all: a phone
              // can't be prompted for a charge on a sale that hasn't
              // reached the server yet (0052 refuses it server-side too,
              // for the same reason, if this ever got through anyway).
              (m) => (momoEnabled && isOnline) || (m.value !== "momo" && m.value !== "split")
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
                onChange={(e) => {
                  const value = e.target.value;
                  setMomoNumber(value);
                  // Pre-select the likely network from the number as the
                  // cashier types, so the network dropdown isn't just
                  // sitting on whatever it defaulted to (usually MTN) for
                  // a customer on a different network — the most likely
                  // cause of a mobile money prompt being declined outright.
                  // Never overrides a network the cashier already chose
                  // for this number by hand.
                  if (!momoNetworkTouched) {
                    const normalised = normaliseMomoNumber(value);
                    const guess = normalised ? guessMomoNetwork(normalised) : null;
                    if (guess) setMomoNetwork(guess);
                  }
                }}
                error={state.fieldErrors?.momoNumber}
              />
              <div className="flex flex-col gap-1.5">
                <Select
                  label="Network"
                  name="momoNetwork"
                  value={momoNetwork}
                  onChange={(e) => {
                    setMomoNetwork(e.target.value);
                    setMomoNetworkTouched(true);
                  }}
                  error={state.fieldErrors?.momoNetwork}
                  options={MOMO_NETWORKS.map((n) => ({ value: n.value, label: n.label }))}
                />
                {!momoNetworkTouched && guessMomoNetwork(normaliseMomoNumber(momoNumber) ?? "") ? (
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    Guessed from the number — change it if this customer ported to another network.
                  </p>
                ) : null}
              </div>
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
        )}
      </div>
    </div>

    {scannerOpen ? (
      <BarcodeScannerModal onDetected={onScanned} onClose={() => setScannerOpen(false)} />
    ) : null}

    {/* The shared Modal shell (components/ui/modal.tsx) replaces what used
        to be a bespoke fixed-overlay dialog here — same two states
        (confirm, then the printable slip), same rule for when a backdrop
        click/Escape is allowed to close it (never while the drawer-open
        request is in flight, and never once the slip is showing — that
        still requires an explicit "Close"), just built on the one modal
        shell the rest of the app now uses instead of its own copy of that
        logic. Wrapped in its own print:hidden div because Modal itself has
        no opinion about printing — the actual print output still comes
        from the plain print:block slip below, unchanged. */}
    <div className="print:hidden">
      <Modal
        open={noSaleOpen}
        onClose={() => setNoSaleOpen(false)}
        size="sm"
        pending={noSalePending || Boolean(noSaleSlip)}
        title={noSaleSlip ? "Drawer opened" : "Open the cash drawer without a sale?"}
        description={
          noSaleSlip
            ? "Logged under your name. If your printer needs a print job to trigger the drawer, print the slip below on it."
            : "For giving change or correcting a mistake — not for completing a purchase. This is recorded to the audit trail under your name."
        }
        footer={
          noSaleSlip ? (
            <>
              <Button type="button" variant="ghost" onClick={() => setNoSaleOpen(false)}>
                Close
              </Button>
              <Button type="button" onClick={() => window.print()}>
                Print
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={() => setNoSaleOpen(false)} disabled={noSalePending}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={noSalePending}
                onClick={() => {
                  setNoSaleError(null);
                  startNoSaleTransition(async () => {
                    const result = await openDrawerNoSale(branchId, noSaleReason);
                    if (!result.ok || !result.slipText) {
                      setNoSaleError(result.error ?? "Something went wrong. Please try again.");
                      return;
                    }
                    setNoSaleSlip(result.slipText);
                  });
                }}
              >
                {noSalePending ? "Opening…" : "Open drawer"}
              </Button>
            </>
          )
        }
      >
        {noSaleSlip ? (
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl bg-neutral-100 p-3 font-mono text-xs dark:bg-neutral-800">
            {noSaleSlip}
          </pre>
        ) : (
          <>
            <label className="block text-sm font-medium" htmlFor="no-sale-reason">
              Reason (optional)
            </label>
            <textarea
              id="no-sale-reason"
              value={noSaleReason}
              onChange={(e) => setNoSaleReason(e.target.value)}
              rows={2}
              placeholder="e.g. giving change for a customer"
              className="mt-1 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white"
            />
            {noSaleError ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{noSaleError}</p> : null}
          </>
        )}
      </Modal>
    </div>

    {/* Print-only: the drawer-open slip. Everything else on this page is
        print:hidden, so printing while this is set sends only the slip to
        the printer — see openDrawerNoSale()'s own comment for why this
        exists instead of direct hardware control. */}
    {noSaleSlip ? (
      <div className="hidden print:block">
        <pre className="whitespace-pre font-mono text-[12px] leading-[1.35]">{noSaleSlip}</pre>
      </div>
    ) : null}
    </>
  );
}