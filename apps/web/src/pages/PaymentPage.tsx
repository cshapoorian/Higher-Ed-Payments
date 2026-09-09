import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  PaymentMethodAvailability,
  PaymentMethodQuote,
  PaymentMethodType,
  SavedPaymentMethod,
  Student,
  Term,
} from "@juspay-takehome/shared";
import {
  apiUrl,
  createPaymentIntent,
  getMe,
  getOrder,
  getPaymentCapabilities,
  getPaymentMethods,
  quotePayment,
} from "../api";
import {
  confirmAchPayment,
  isValidRoutingNumber,
  loadHyper,
  type HyperElements,
  type HyperInstance,
} from "../lib/hyperswitch";
import { useCart } from "../state/CartContext";

// How long to keep polling for the webhook-driven terminal status before
// telling the student to check back later instead of spinning forever. ACH
// in particular can sit in "processing" well past this window in the real
// world — ample for the sandbox's near-instant test connectors.
const ORDER_POLL_INTERVAL_MS = 2000;
const ORDER_POLL_TIMEOUT_MS = 30000;

interface MethodMeta {
  type: PaymentMethodType;
  label: string;
  hint: string;
  icon: string;
}

const ALWAYS_AVAILABLE_METHODS: MethodMeta[] = [
  { type: "card_new", label: "New card", hint: "Visa, Mastercard, Amex, Discover", icon: "💳" },
  { type: "ach", label: "Bank transfer (ACH)", hint: "Link your bank — no fee", icon: "🏦" },
  { type: "installment_plan", label: "Split into 4 payments", hint: "Charged automatically every 30 days", icon: "📆" },
];

// "Card ending 4242 (saved)" is only ever shown when GET /api/payment-methods
// actually returns a saved Hyperswitch payment method for this student — see
// ENDPOINTS.md. Note this still confirms through the same hosted-fields flow
// as "New card" today; a true one-click charge against the stored token
// would need a separate confirm path and isn't wired up (see the report at
// the end of this work for why).
function savedCardMethod(saved: SavedPaymentMethod): MethodMeta {
  return {
    type: "card_saved",
    label: `Card ending ${saved.last4}`,
    hint: `Expires ${saved.expiryMonth}/${saved.expiryYear} — saved on file`,
    icon: "✓",
  };
}

// Quick-select tiles for the ACH "link your bank" panel. These are a
// progressive-disclosure affordance, NOT an OAuth/Plaid bank link — picking
// one simply reveals the manual routing/account form, and the copy says so
// rather than implying a credential handoff that doesn't exist.
interface BankOption {
  id: string;
  name: string;
  mark: string;
}

const BANK_OPTIONS: BankOption[] = [
  { id: "chase", name: "Chase", mark: "C" },
  { id: "boa", name: "Bank of America", mark: "BoA" },
  { id: "wells", name: "Wells Fargo", mark: "WF" },
  { id: "citi", name: "Citibank", mark: "C" },
  { id: "capone", name: "Capital One", mark: "CO" },
  { id: "usbank", name: "US Bank", mark: "US" },
];

interface BillingAddressState {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

const EMPTY_BILLING: BillingAddressState = {
  name: "",
  line1: "",
  line2: "",
  city: "",
  state: "",
  zip: "",
  country: "US",
};

interface BankDetailsState {
  bankId: string | null;
  accountHolderName: string;
  accountType: "checking" | "savings";
  routingNumber: string;
  accountNumber: string;
}

const EMPTY_BANK: BankDetailsState = {
  bankId: null,
  accountHolderName: "",
  accountType: "checking",
  routingNumber: "",
  accountNumber: "",
};

// US ABA routing numbers are exactly 9 digits (the ninth is a check digit —
// see isValidRoutingNumber); account numbers run 4–17 with no check digit.
const ROUTING_DIGITS = 9;
const ACCOUNT_MIN_DIGITS = 4;
const ACCOUNT_MAX_DIGITS = 17;

// Which methods are funded by a card and therefore need Hyperswitch's hosted
// card iframe. ACH is the odd one out: it has no element to mount and
// confirms through confirmAchPayment instead (see lib/hyperswitch.ts), so it
// must not be made to wait on the SDK loading.
function methodNeedsHostedCard(method: PaymentMethodType | null): boolean {
  return method === "card_new" || method === "installment_plan" || method === "card_saved";
}

// Everything the browser needs to confirm the open Payment Intent. Held
// together in one object because a half-populated set of these is never
// useful — clearing it is how "no intent open yet" is represented.
interface OpenIntent {
  paymentId: string;
  clientSecret: string;
  publishableKey: string;
  hyperswitchBaseUrl: string;
}

function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Confirms directly with Hyperswitch using the client secret from our own
// Payment Intent — card data never touches the storefront API. Order state
// then advances via webhook, not this confirmation call. See architecture §5.
export function PaymentPage() {
  const { invoice, order, setOrder } = useCart();
  const navigate = useNavigate();

  const [quotes, setQuotes] = useState<Partial<Record<PaymentMethodType, PaymentMethodQuote>>>({});
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodType | null>(null);
  const [hyperInstance, setHyperInstance] = useState<HyperInstance | null>(null);
  const [elements, setElements] = useState<HyperElements | null>(null);
  // "submitted" is the ACH happy path and is distinct from "paid": the debit
  // has been accepted by the network but will not settle for days, so the
  // student needs a different, non-celebratory answer than a card gets.
  const [status, setStatus] = useState<
    "idle" | "loading" | "processing" | "submitted" | "paid" | "timeout" | "error"
  >("idle");
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [savedMethod, setSavedMethod] = useState<SavedPaymentMethod | null>(null);
  const [intent, setIntent] = useState<OpenIntent | null>(null);
  // null while the capability check is in flight — deliberately not defaulted
  // to "available", so a slow or failed check never lets a student start a
  // payment the account cannot take.
  const [achAvailability, setAchAvailability] = useState<PaymentMethodAvailability | null>(null);
  const [term, setTerm] = useState<Term | null>(null);
  const [student, setStudent] = useState<Student | null>(null);
  // The hosted card iframe reports "ready" when its inputs have painted; it
  // never reports per-keystroke validity (see lib/hyperswitch.ts). So this
  // gates on "the field exists and is usable", not "the card is complete" —
  // Hyperswitch itself rejects an incomplete card at confirm, and we surface
  // that message. Gating on completeness instead left Pay disabled forever.
  const [elementReady, setElementReady] = useState(false);
  const [elementFailed, setElementFailed] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [billing, setBilling] = useState<BillingAddressState>(EMPTY_BILLING);
  const [bank, setBank] = useState<BankDetailsState>(EMPTY_BANK);
  const cardMountRef = useRef<HTMLDivElement>(null);
  // Every card-funded method needs the hosted card iframe, not just "New
  // card". The installment plan is merchant-financed *on a card* (the intent
  // is created with setup_future_usage=off_session so later instalments can
  // be charged against the stored mandate), and "saved card" still confirms
  // through the same hosted flow today rather than a true one-click token
  // charge. Leaving them without a card field enabled Pay with no payment
  // method attached, which hung on "Processing…" until the poll timed out.
  const needsHostedCard = methodNeedsHostedCard(selectedMethod);
  // Whether ACH can actually be charged is a property of the Hyperswitch
  // account, not of this code, so it is read from GET /api/payment-capabilities
  // rather than hardcoded. On the current sandbox account the answer is no —
  // none of its connectors implement bank_debit — but the moment one is added
  // in the dashboard this flips on its own. See services/achAvailability.ts.
  const achUnavailable = selectedMethod === "ach" && achAvailability?.available !== true;

  const METHODS = useMemo<MethodMeta[]>(
    () => (savedMethod ? [savedCardMethod(savedMethod), ...ALWAYS_AVAILABLE_METHODS] : ALWAYS_AVAILABLE_METHODS),
    [savedMethod],
  );

  useEffect(() => {
    // Failure here is treated as "ACH unavailable", not as a page error: card
    // is unaffected, and the one thing we must not do is offer a method whose
    // chargeability we could not confirm.
    getPaymentCapabilities()
      .then((caps) => setAchAvailability(caps.ach))
      .catch((err) => {
        console.error(err);
        setAchAvailability({
          available: false,
          reason: "Bank transfers aren't available right now — pay by card instead.",
          detail: "GET /api/payment-capabilities failed, so ACH chargeability could not be confirmed.",
        });
      });
  }, []);

  useEffect(() => {
    getMe().then(({ student, term }) => {
      setTerm(term);
      setStudent(student);
      setBilling((b) => ({ ...b, name: student.name }));
      getPaymentMethods(student.id).then((res) => setSavedMethod(res.paymentMethods[0] ?? null));
    });
  }, []);

  useEffect(() => {
    if (!invoice) return;
    let cancelled = false;
    Promise.all(
      METHODS.map((m) =>
        quotePayment({ invoiceId: invoice.id, method: m.type }).then((res) => [m.type, res.quote] as const),
      ),
    ).then((entries) => {
      if (!cancelled) setQuotes(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [invoice, METHODS]);

  useEffect(() => {
    setElementReady(false);
    setElementFailed(false);
    if (!needsHostedCard || !elements || !cardMountRef.current) return;

    // Only the card element is mounted. ACH deliberately does NOT mount
    // elements.create("payment"): on this merchant account that unified
    // element renders a *card* form (verified live — no bank-debit connector
    // is enabled, so Hyperswitch falls back to card), which under a "Link
    // your bank" heading would invite a student to type card data into what
    // they believe is a bank transfer. See TEST_CREDENTIALS.md.
    const el = elements.create("card");
    el.mount("#hyper-payment-element");
    el.on("ready", () => setElementReady(true));

    // If "ready" never arrives the iframe is wedged (bad SDK URL, blocked
    // network, CSP). Say so instead of leaving an inert grey box on screen.
    const timer = window.setTimeout(() => {
      setElementReady((ready) => {
        if (!ready) setElementFailed(true);
        return ready;
      });
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [selectedMethod, elements, needsHostedCard]);

  if (!invoice) {
    navigate("/review");
    return null;
  }

  async function selectMethod(method: PaymentMethodType) {
    // Re-picking the current method is normally a no-op — except after a
    // failure, where it *is* the retry. A Hyperswitch intent that failed can't
    // be confirmed a second time, so retrying has to open a fresh one; without
    // this the only way back from a declined payment was to switch methods.
    if (selectedMethod === method && status !== "error") return;
    setSelectedMethod(method);
    setElements(null);
    setHyperInstance(null);
    setIntent(null);
    setReceiptUrl(null);
    setBank(EMPTY_BANK);
    setErrorMessage(null);
    setStatus("loading");
    try {
      const { order, clientSecret, publishableKey, hyperswitchBaseUrl } = await createPaymentIntent({
        invoiceId: invoice!.id,
        method,
      });
      setOrder(order);
      // paymentIntentId is non-null on a freshly created intent; the type is
      // nullable because an Order exists before one is opened.
      if (!order.paymentIntentId) throw new Error("Payment intent was not created");
      setIntent({
        paymentId: order.paymentIntentId,
        clientSecret,
        publishableKey,
        hyperswitchBaseUrl,
      });

      // ACH has nothing to mount, so it doesn't wait on the SDK — loading it
      // anyway would make a bank transfer fail whenever HyperLoader.js is
      // blocked, for no benefit.
      if (methodNeedsHostedCard(method)) {
        const hyper = await loadHyper(publishableKey);
        setHyperInstance(hyper);
        setElements(hyper.elements({ clientSecret }));
      }
      setStatus("idle");
    } catch (err) {
      console.error(err);
      setErrorMessage(err instanceof Error ? err.message : null);
      setStatus("error");
    }
  }

  // Card-funded methods: hand the mounted hosted element to the SDK, which
  // confirms with the publishable key. The PAN never enters this function.
  async function confirmWithHostedCard() {
    if (!elements || !hyperInstance) throw new Error("Card fields aren't ready yet");

    const result = await hyperInstance.confirmPayment({
      elements,
      confirmParams: {
        return_url: window.location.href,
        payment_method_data: {
          billing_details: {
            name: billing.name,
            email: student?.email,
            address: {
              line1: billing.line1,
              line2: billing.line2 || undefined,
              city: billing.city,
              state: billing.state,
              postal_code: billing.zip,
              country: billing.country,
            },
          },
        },
      },
      redirect: "if_required",
    });
    if (result.error) throw new Error(result.error.message);
  }

  // ACH: no hosted element exists for it, so the bank details go straight from
  // this browser to Hyperswitch's confirm endpoint with the publishable key.
  // They never transit apps/api. See lib/hyperswitch.ts for why that's the
  // right boundary for bank data specifically, and not for cards.
  async function confirmAch() {
    if (!intent) throw new Error("No payment intent is open");

    await confirmAchPayment({
      hyperswitchBaseUrl: intent.hyperswitchBaseUrl,
      publishableKey: intent.publishableKey,
      paymentId: intent.paymentId,
      clientSecret: intent.clientSecret,
      bank: {
        accountHolderName: bank.accountHolderName,
        routingNumber: bank.routingNumber,
        accountNumber: bank.accountNumber,
        accountType: bank.accountType,
      },
      billingDetails: { name: bank.accountHolderName, email: student?.email },
    });
  }

  async function confirm() {
    if (!intent) return;
    if (!extraFieldsValid) return;
    const isAch = selectedMethod === "ach";
    setErrorMessage(null);
    setStatus("processing");
    try {
      if (isAch) {
        await confirmAch();
      } else {
        await confirmWithHostedCard();
      }
      // The Hyperswitch webhook, not the confirm response, is what actually
      // moves the order — see architecture §5 step 6. Poll our own API for
      // that status instead of trusting this client-side result.
      await pollOrderStatus({ settlesLater: isAch });
    } catch (err) {
      console.error(err);
      // Show what Hyperswitch actually said ("Your card number is incomplete",
      // "Card declined", "Bank transfers aren't enabled on this account", …).
      // A blanket "Payment failed" gives the student nothing to act on, and
      // an incomplete card is the most likely cause now that the Pay button
      // no longer waits on a completeness signal.
      setErrorMessage(err instanceof Error ? err.message : null);
      setStatus("error");
    }
  }

  /**
   * Polls our own API — which force_syncs against Hyperswitch — until the
   * order reaches a state worth showing.
   *
   * `settlesLater` is what makes ACH correct rather than merely tolerated.
   * For a card, "processing" is a transient blip on the way to paid and we
   * should keep waiting. For ACH it is the *destination*: the debit has been
   * accepted and will clear over the next few business days, so continuing to
   * poll would only ever end in a misleading timeout. Same state machine,
   * different terminal state.
   */
  async function pollOrderStatus({ settlesLater = false }: { settlesLater?: boolean } = {}) {
    const orderId = order?.id;
    if (!orderId) return;

    const deadline = Date.now() + ORDER_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { order: latest, receiptUrl: latestReceiptUrl } = await getOrder(orderId);
      setOrder(latest);
      if (latest.status === "paid") {
        setReceiptUrl(latestReceiptUrl);
        setStatus("paid");
        return;
      }
      if (latest.status === "failed") {
        setStatus("error");
        return;
      }
      if (settlesLater && latest.status === "processing") {
        setStatus("submitted");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, ORDER_POLL_INTERVAL_MS));
    }
    // Nothing terminal within our patience window — tell the student to check
    // back rather than spinning "Processing…" indefinitely.
    setStatus("timeout");
  }

  const selectedQuote = selectedMethod ? quotes[selectedMethod] : undefined;
  const invoiceNumber = invoice!.id.slice(-6).toUpperCase();

  // Done with this invoice, one way or the other. ACH ends at "submitted"
  // rather than "paid" — the money hasn't moved yet — but the page collapses
  // the same way, because leaving a filled-in bank form on screen under a
  // banner reads as "did that actually go through?".
  const isTerminal = status === "paid" || status === "submitted";

  const billingValid =
    billing.name.trim() !== "" &&
    billing.line1.trim() !== "" &&
    billing.city.trim() !== "" &&
    billing.state.trim() !== "" &&
    billing.zip.trim() !== "";
  // Unlike a card, ACH details are typed into our own inputs, so we can and
  // should catch what's provably wrong before submitting: a routing number
  // that fails its ABA check digit is a typo, full stop. Errors appear only
  // once a field holds enough to judge, so they don't shout mid-keystroke.
  const routingError =
    bank.routingNumber.length === ROUTING_DIGITS && !isValidRoutingNumber(bank.routingNumber)
      ? "That routing number isn't valid. Check the nine digits in the bottom-left corner of a check."
      : null;
  const accountError =
    bank.accountNumber.length > 0 && bank.accountNumber.length < ACCOUNT_MIN_DIGITS
      ? `Account numbers are ${ACCOUNT_MIN_DIGITS}–${ACCOUNT_MAX_DIGITS} digits.`
      : null;
  const bankValid =
    bank.accountHolderName.trim() !== "" &&
    isValidRoutingNumber(bank.routingNumber) &&
    bank.accountNumber.length >= ACCOUNT_MIN_DIGITS;
  const extraFieldsValid = needsHostedCard ? billingValid : selectedMethod === "ach" ? bankValid : true;

  // Pay is blocked only by things we can actually observe: the intent still
  // being created, our own address/bank fields being incomplete or invalid,
  // the hosted card iframe not having painted (card only — ACH has no
  // iframe), or the account not being able to charge ACH at all.
  const payDisabled =
    status !== "idle" ||
    !intent ||
    !extraFieldsValid ||
    (needsHostedCard && (!elements || !hyperInstance || !elementReady || elementFailed)) ||
    achUnavailable;

  function renderMethodCard(m: MethodMeta) {
    const quote = quotes[m.type];
    const isSelected = selectedMethod === m.type;
    return (
      <button
        key={m.type}
        className={`card method-card ${isSelected ? "is-selected" : ""}`}
        disabled={status === "processing" || isTerminal}
        onClick={() => selectMethod(m.type)}
      >
        <div className="method-card-top">
          <div className="method-card-label">
            <span className="method-icon" aria-hidden="true">
              {m.icon}
            </span>
            <div>
              <div className="method-name">{m.label}</div>
              <div className="method-hint">{m.hint}</div>
            </div>
          </div>
          <div className="method-card-amount">
            {quote?.feeCents === 0 ? (
              <strong>No fee</strong>
            ) : (
              <strong>{quote ? formatUsd(quote.totalCents) : formatUsd(invoice!.balanceDueCents)}</strong>
            )}
            {quote && quote.feeCents > 0 && <span className="fee-pill surcharge">+{formatUsd(quote.feeCents)} fee</span>}
          </div>
        </div>

        {isSelected && quote?.installmentSchedule && (
          <div className="installment-breakdown">
            {quote.installmentSchedule.map((entry) => (
              <div className="installment-entry" key={entry.sequence}>
                <div className="n">Payment {entry.sequence}</div>
                <div className="amt">{formatUsd(entry.amountCents)}</div>
                <div className="d">{formatShortDate(entry.dueDate)}</div>
              </div>
            ))}
          </div>
        )}
      </button>
    );
  }

  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Step 3 of 3</span>
        <h1>Payment</h1>
        {!isTerminal && (
          <p>ACH is free. Card payments — including the installment plan — carry a processing fee, shown up front.</p>
        )}
      </div>

      {/* Hidden once paid: a "Balance due $1,550" block sitting above a
          "Payment received" card reads as though the payment didn't land. */}
      {!isTerminal && (
        <>
      <div className="invoice-eyebrow">
        Invoice — {term ? term.label.toUpperCase() : ""} · #{invoiceNumber}
      </div>
      <div className="card invoice-recap">
        <ul className="line-items">
          {invoice!.lineItems.map((item, i) => (
            <li key={i} className={item.kind === "aid_credit" ? "credit" : undefined}>
              <span>{item.description}</span>
              <span>{formatUsd(item.amountCents)}</span>
            </li>
          ))}
        </ul>
        <div className="invoice-divider" />
        <div className="balance-due">
          <span className="label">Balance due</span>
          <span className="amount">{formatUsd(invoice!.balanceDueCents)}</span>
        </div>
        <p className="balance-note">Full line-item detail is on the review step.</p>
      </div>

      <a className="finaid-link" href="mailto:financialaid@meridian.edu">
        Apply financial aid or link student aid account →
      </a>

      <div className="trust-badges">
        <span className="badge-pill">256-bit encrypted</span>
        <span className="badge-pill">PCI-DSS compliant</span>
        <span className="badge-pill">FERPA-safe</span>
      </div>

      {/* Once the order is paid, the chooser and the entry forms are no longer
          actionable — leaving a filled-in card form on screen under a one-line
          banner reads as "did that go through?". Collapse to a receipt. */}
      <div className="method-section-label">Payment method</div>
      <div className="method-list">{METHODS.map(renderMethodCard)}</div>
        </>
      )}

      {needsHostedCard && !isTerminal && (
        <div className="pay-panel">
          <div className="panel-header">
            <h3>Card information</h3>
            <div className="card-brand-row" aria-hidden="true">
              <span className="brand-badge">VISA</span>
              <span className="brand-badge">Mastercard</span>
              <span className="brand-badge">Amex</span>
              <span className="brand-badge">Discover</span>
            </div>
          </div>
          {/* Truthful copy, not the copy we'd like to be true: the intent is
              created for quote.totalCents and no mandate is stored, so this
              charges the whole balance now. Saying "$X today, rest later"
              here would be a straightforward misrepresentation. */}
          {selectedMethod === "installment_plan" && selectedQuote?.installmentSchedule && (
            <div className="notice notice-warn" role="status">
              <strong>This charges the full {formatUsd(selectedQuote.totalCents)} today.</strong> The schedule above is
              what a mandate-backed plan would collect, but recurring collection isn't wired up yet — no mandate is
              stored and payments 2–{selectedQuote.installmentSchedule.length} are never taken. Use “New card” unless
              you're specifically exercising the plan's pricing.
            </div>
          )}
          {/* The hosted element below renders the card number, expiration, and
              CVC inputs itself — none of that ever passes through our JSX or
              our API. See lib/hyperswitch.ts and architecture §4. */}
          <label className="field-label" htmlFor="hyper-payment-element">
            Card number, expiration and CVC
          </label>
          <div className={`hosted-field-shell ${elementReady ? "is-ready" : ""}`}>
            <div id="hyper-payment-element" ref={cardMountRef} />
            {!elementReady && !elementFailed && (
              <div className="hosted-field-skeleton" aria-live="polite">
                Loading secure card fields…
              </div>
            )}
          </div>
          {elementFailed && (
            <p className="field-error" role="alert">
              Secure card fields couldn't load, so payment can't be taken right now. Check that
              VITE_HYPERSWITCH_SDK_URL points at a reachable HyperLoader.js, then reload.
            </p>
          )}

          <h3 className="panel-subheader">Billing address</h3>
          <div className="form-grid">
            <label className="form-field span-2">
              <span>Name on card</span>
              <input
                autoComplete="cc-name"
                value={billing.name}
                onChange={(e) => setBilling({ ...billing, name: e.target.value })}
                placeholder="Jordan Rivera"
              />
            </label>
            <label className="form-field span-2">
              <span>Country</span>
              <select
                autoComplete="country"
                value={billing.country}
                onChange={(e) => setBilling({ ...billing, country: e.target.value })}
              >
                <option value="US">United States</option>
                <option value="CA">Canada</option>
                <option value="MX">Mexico</option>
                <option value="GB">United Kingdom</option>
              </select>
            </label>
            <label className="form-field span-2">
              <span>Address line 1</span>
              <input
                autoComplete="address-line1"
                value={billing.line1}
                onChange={(e) => setBilling({ ...billing, line1: e.target.value })}
                placeholder="123 Campus Way"
              />
            </label>
            <label className="form-field span-2">
              <span>
                Address line 2 <em>(optional)</em>
              </span>
              <input
                autoComplete="address-line2"
                value={billing.line2}
                onChange={(e) => setBilling({ ...billing, line2: e.target.value })}
                placeholder="Apt, suite, etc."
              />
            </label>
            <label className="form-field">
              <span>City</span>
              <input
                autoComplete="address-level2"
                value={billing.city}
                onChange={(e) => setBilling({ ...billing, city: e.target.value })}
              />
            </label>
            <label className="form-field">
              <span>State</span>
              <input
                autoComplete="address-level1"
                maxLength={2}
                value={billing.state}
                onChange={(e) => setBilling({ ...billing, state: e.target.value.toUpperCase() })}
                placeholder="CA"
              />
            </label>
            <label className="form-field">
              <span>ZIP</span>
              <input
                autoComplete="postal-code"
                inputMode="numeric"
                value={billing.zip}
                onChange={(e) => setBilling({ ...billing, zip: e.target.value })}
                placeholder="94305"
              />
            </label>
          </div>
        </div>
      )}

      {selectedMethod === "ach" && !isTerminal && (
        <div className="pay-panel">
          <h3>Link your bank</h3>
          <p className="panel-hint">
            Pick your bank to prefill the form below, or choose “Other bank” to enter the details yourself.
          </p>
          <div className="bank-grid">
            {BANK_OPTIONS.map((b) => (
              <button
                type="button"
                key={b.id}
                className={`bank-tile ${bank.bankId === b.id ? "is-selected" : ""}`}
                onClick={() => setBank({ ...bank, bankId: b.id })}
              >
                <span className="bank-tile-mark">{b.mark}</span>
                <span>{b.name}</span>
              </button>
            ))}
            <button
              type="button"
              className={`bank-tile ${bank.bankId === "other" ? "is-selected" : ""}`}
              onClick={() => setBank({ ...bank, bankId: "other" })}
            >
              <span className="bank-tile-mark">+</span>
              <span>Other bank</span>
            </button>
          </div>

          <h3 className="panel-subheader">Account details</h3>
          <div className="form-grid">
            <label className="form-field span-2">
              <span>Account holder name</span>
              <input
                autoComplete="name"
                value={bank.accountHolderName}
                onChange={(e) => setBank({ ...bank, accountHolderName: e.target.value })}
                placeholder="Jordan Rivera"
              />
            </label>
          </div>
          <div className="segmented" role="radiogroup" aria-label="Account type">
            <button
              type="button"
              aria-pressed={bank.accountType === "checking"}
              className={bank.accountType === "checking" ? "is-active" : ""}
              onClick={() => setBank({ ...bank, accountType: "checking" })}
            >
              Checking
            </button>
            <button
              type="button"
              aria-pressed={bank.accountType === "savings"}
              className={bank.accountType === "savings" ? "is-active" : ""}
              onClick={() => setBank({ ...bank, accountType: "savings" })}
            >
              Savings
            </button>
          </div>

          {/* Explicit, labelled inputs. This is bank-account data, not
              cardholder data — it's outside PCI's SAQ-A scope, and it still
              goes to Hyperswitch from the browser rather than through our own
              API. Previously this spot mounted Hyperswitch's unified element,
              which on this account renders a *card* form; see the mount
              effect above for why that was removed. */}
          <div className="form-grid ach-numbers">
            <label className="form-field">
              <span>Routing number</span>
              <input
                inputMode="numeric"
                autoComplete="off"
                maxLength={ROUTING_DIGITS}
                value={bank.routingNumber}
                aria-invalid={routingError !== null}
                onChange={(e) =>
                  setBank({ ...bank, routingNumber: e.target.value.replace(/\D/g, "").slice(0, ROUTING_DIGITS) })
                }
                placeholder="9 digits"
              />
              {routingError && (
                <p className="field-error" role="alert">
                  {routingError}
                </p>
              )}
            </label>
            <label className="form-field">
              <span>Account number</span>
              <input
                inputMode="numeric"
                autoComplete="off"
                maxLength={ACCOUNT_MAX_DIGITS}
                value={bank.accountNumber}
                aria-invalid={accountError !== null}
                onChange={(e) =>
                  setBank({
                    ...bank,
                    accountNumber: e.target.value.replace(/\D/g, "").slice(0, ACCOUNT_MAX_DIGITS),
                  })
                }
                placeholder={`${ACCOUNT_MIN_DIGITS}–${ACCOUNT_MAX_DIGITS} digits`}
              />
              {accountError && (
                <p className="field-error" role="alert">
                  {accountError}
                </p>
              )}
            </label>
          </div>

          {/* Not a hardcoded caveat: this is whatever GET /api/payment-capabilities
              found on the live Hyperswitch account, so it disappears by itself
              once a bank-debit connector is added. `detail` is the operator's
              half of the answer — the exact gap and the error a confirm would
              return — which is the thing you'd otherwise have to go digging
              for. See TEST_CREDENTIALS.md. */}
          {achAvailability && !achAvailability.available && (
            <div className="notice notice-warn" role="status">
              <strong>{achAvailability.reason}</strong>
              {achAvailability.detail && <span className="notice-detail">{achAvailability.detail}</span>}
            </div>
          )}
          {achAvailability?.available && (
            <p className="panel-hint ach-timing-note">
              Bank transfers take 3–5 business days to clear. Your enrollment is held as soon as the transfer is
              submitted — you'll get the receipt by email once it settles.
            </p>
          )}
        </div>
      )}

      {selectedMethod && !isTerminal && (
        <div className="pay-confirm">
          <button className="btn btn-primary btn-block" disabled={payDisabled} onClick={confirm}>
            {status === "processing"
              ? selectedMethod === "ach"
                ? "Submitting transfer…"
                : "Processing…"
              : status === "loading"
                ? "Preparing…"
                : selectedMethod === "ach" && achAvailability === null
                  ? "Checking availability…"
                  : achUnavailable
                    ? "Bank transfer unavailable"
                    : selectedMethod === "ach"
                      ? `Authorize transfer of ${selectedQuote ? formatUsd(selectedQuote.totalCents) : ""}`
                      : `Confirm & pay ${selectedQuote ? formatUsd(selectedQuote.totalCents) : ""}`}
          </button>
          <p className="pay-footnote">🔒 Secured by Hyperswitch · Refund & cancellation policy · Itemized PDF receipt</p>
        </div>
      )}

      {status === "processing" && (
        <div className="status-banner processing">
          Processing your payment — waiting for confirmation from Hyperswitch…
        </div>
      )}
      {status === "submitted" && (
        <div className="card paid-card" role="status">
          <div className="paid-check submitted-check" aria-hidden="true">
            ⏳
          </div>
          <h2>Transfer submitted</h2>
          <p className="paid-amount">{formatUsd(selectedQuote?.totalCents ?? invoice!.balanceDueCents)}</p>
          <p className="paid-sub">
            From your {bank.accountType} account ending {bank.accountNumber.slice(-4)} · Invoice #{invoiceNumber}
            {term ? ` · ${term.label}` : ""}
          </p>
          {/* Deliberately not a receipt and not a checkmark. An ACH debit is
              accepted now and settles over the following business days; the
              order only becomes Paid on the settlement webhook, so promising
              a paid balance here would be a lie the webhook later corrects. */}
          <p className="paid-note">
            Bank transfers clear in 3–5 business days. Your seats are held in the meantime, and your itemized receipt
            is emailed the moment the transfer settles — there's nothing else to do, and no need to pay again.
          </p>
        </div>
      )}
      {status === "paid" && (
        <div className="card paid-card" role="status">
          <div className="paid-check" aria-hidden="true">
            ✓
          </div>
          <h2>Payment received</h2>
          <p className="paid-amount">{formatUsd(selectedQuote?.totalCents ?? invoice!.balanceDueCents)}</p>
          <p className="paid-sub">
            Paid to Meridian University · Invoice #{invoiceNumber}
            {term ? ` · ${term.label}` : ""}
          </p>
          {receiptUrl ? (
            <a className="btn btn-primary" href={apiUrl(receiptUrl)} target="_blank" rel="noreferrer">
              View itemized receipt
            </a>
          ) : (
            <p className="paid-sub">Your receipt is being generated…</p>
          )}
          <p className="paid-note">Keep this receipt for your records — your balance is now settled.</p>
        </div>
      )}
      {status === "timeout" && (
        <div className="status-banner processing" role="status">
          Still confirming with your bank or card issuer — this can take a few minutes for ACH. Check back on this
          order shortly; you don't need to pay again.
        </div>
      )}
      {status === "error" && (
        <div className="status-banner error" role="alert">
          {errorMessage
            ? `Payment failed — ${errorMessage}`
            : "Payment failed — please try again or choose a different method."}
          <span className="status-banner-hint">
            Nothing was charged. Select a payment method above to try again.
          </span>
        </div>
      )}

      <div className="nav-row">
        {isTerminal ? (
          // Deliberately not "back to review": that path re-enters the payment
          // step for an invoice that is already settled. The API now rejects a
          // second intent (409), but the flow shouldn't invite it either.
          <button className="btn btn-ghost" onClick={() => navigate("/")}>
            ← Back to course selection
          </button>
        ) : (
          <button className="btn btn-ghost" disabled={status === "processing"} onClick={() => navigate("/review")}>
            ← Back to review
          </button>
        )}
      </div>
    </div>
  );
}
