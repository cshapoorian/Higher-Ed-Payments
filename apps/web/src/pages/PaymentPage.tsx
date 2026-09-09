import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PaymentMethodQuote, PaymentMethodType, SavedPaymentMethod, Student, Term } from "@juspay-takehome/shared";
import { apiUrl, createPaymentIntent, getMe, getOrder, getPaymentMethods, quotePayment } from "../api";
import { loadHyper, type HyperElements, type HyperInstance } from "../lib/hyperswitch";
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

// Quick-select tiles for the ACH "link your bank" panel. Purely a UI
// affordance to make bank selection feel like the Plaid-style pickers modern
// checkouts use — no OAuth bank linking is wired up, so every choice (including
// "Other bank") converges on the same manual routing/account entry below,
// which is still collected through Hyperswitch's hosted field, never as a
// raw input we touch. See lib/hyperswitch.ts and architecture §4.
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
}

const EMPTY_BANK: BankDetailsState = { bankId: null, accountHolderName: "", accountType: "checking" };

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
  const [status, setStatus] = useState<"idle" | "loading" | "processing" | "paid" | "timeout" | "error">("idle");
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [savedMethod, setSavedMethod] = useState<SavedPaymentMethod | null>(null);
  const [term, setTerm] = useState<Term | null>(null);
  const [student, setStudent] = useState<Student | null>(null);
  // Only card_new and ach mount a field-collection widget below; both start
  // false so Confirm stays disabled until the student has actually entered
  // something. card_saved/installment_plan never gate on this.
  const [fieldsComplete, setFieldsComplete] = useState(false);
  const [billing, setBilling] = useState<BillingAddressState>(EMPTY_BILLING);
  const [bank, setBank] = useState<BankDetailsState>(EMPTY_BANK);
  const cardMountRef = useRef<HTMLDivElement>(null);
  const needsFieldEntry = selectedMethod === "card_new" || selectedMethod === "ach";

  const METHODS = useMemo<MethodMeta[]>(
    () => (savedMethod ? [savedCardMethod(savedMethod), ...ALWAYS_AVAILABLE_METHODS] : ALWAYS_AVAILABLE_METHODS),
    [savedMethod],
  );

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
    setFieldsComplete(false);
    if (!needsFieldEntry || !elements || !cardMountRef.current) return;
    // ach mounts the general-purpose "payment" element (bank-account fields);
    // card_new mounts the dedicated "card" element. Neither collects anything
    // until the student types into it, and Confirm stays disabled until the
    // "change" event below reports complete: true.
    const el = elements.create(selectedMethod === "card_new" ? "card" : "payment");
    el.mount("#hyper-payment-element");
    el.on("change", (event) => setFieldsComplete(Boolean(event.complete)));
  }, [selectedMethod, elements, needsFieldEntry]);

  if (!invoice) {
    navigate("/review");
    return null;
  }

  async function selectMethod(method: PaymentMethodType) {
    if (selectedMethod === method) return;
    setSelectedMethod(method);
    setElements(null);
    setHyperInstance(null);
    setReceiptUrl(null);
    setBank(EMPTY_BANK);
    setStatus("loading");
    try {
      const { order, clientSecret, publishableKey } = await createPaymentIntent({
        invoiceId: invoice!.id,
        method,
      });
      setOrder(order);

      const hyper = await loadHyper(publishableKey);
      setHyperInstance(hyper);
      setElements(hyper.elements({ clientSecret }));
      setStatus("idle");
    } catch (err) {
      console.error(err);
      setStatus("error");
    }
  }

  async function confirm() {
    if (!elements || !hyperInstance) return;
    if (needsFieldEntry && !fieldsComplete) return;
    if (!extraFieldsValid) return;
    setStatus("processing");
    try {
      const billingDetails =
        selectedMethod === "card_new"
          ? {
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
            }
          : selectedMethod === "ach"
            ? { name: bank.accountHolderName, email: student?.email }
            : undefined;

      const result = await hyperInstance.confirmPayment({
        elements,
        confirmParams: {
          return_url: window.location.href,
          ...(billingDetails ? { payment_method_data: { billing_details: billingDetails } } : {}),
        },
        redirect: "if_required",
      });
      if (result.error) throw new Error(result.error.message);
      // The Hyperswitch webhook, not this response, is what actually moves the
      // order to Paid — see architecture §5 step 6. Poll our own API for that
      // terminal status instead of trusting this client-side result.
      await pollOrderStatus();
    } catch (err) {
      console.error(err);
      setStatus("error");
    }
  }

  async function pollOrderStatus() {
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
      await new Promise((resolve) => setTimeout(resolve, ORDER_POLL_INTERVAL_MS));
    }
    // Webhook hasn't landed within our patience window — tell the student to
    // check back rather than spinning the "Processing…" state indefinitely.
    setStatus("timeout");
  }

  const selectedQuote = selectedMethod ? quotes[selectedMethod] : undefined;
  const invoiceNumber = invoice!.id.slice(-6).toUpperCase();

  const billingValid =
    billing.name.trim() !== "" &&
    billing.line1.trim() !== "" &&
    billing.city.trim() !== "" &&
    billing.state.trim() !== "" &&
    billing.zip.trim() !== "";
  const bankValid = bank.accountHolderName.trim() !== "";
  const extraFieldsValid =
    selectedMethod === "card_new" ? billingValid : selectedMethod === "ach" ? bankValid : true;

  function renderMethodCard(m: MethodMeta) {
    const quote = quotes[m.type];
    const isSelected = selectedMethod === m.type;
    return (
      <button
        key={m.type}
        className={`card method-card ${isSelected ? "is-selected" : ""}`}
        disabled={status === "processing" || status === "paid"}
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
        <p>ACH is free. Card payments — including the installment plan — carry a processing fee, shown up front.</p>
      </div>

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

      <div className="method-section-label">Payment method</div>
      <div className="method-list">{METHODS.map(renderMethodCard)}</div>

      {selectedMethod === "card_new" && (
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
          {/* The hosted element below renders the card number, expiration, and
              CVC inputs itself — none of that ever passes through our JSX or
              our API. See lib/hyperswitch.ts and architecture §4. */}
          <div className="hosted-field-shell">
            <div id="hyper-payment-element" ref={cardMountRef} />
          </div>

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

      {selectedMethod === "ach" && (
        <div className="pay-panel">
          <h3>Link your bank</h3>
          <p className="panel-hint">
            Choose your bank to connect it securely, or enter your account and routing number manually below.
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

          {/* Routing/account numbers are the sensitive part — those stay in
              Hyperswitch's hosted element, same boundary as card data. */}
          <div className="hosted-field-shell">
            <div id="hyper-payment-element" ref={cardMountRef} />
          </div>
          <p className="panel-microcopy">
            🔒 Your routing and account numbers are encrypted and sent directly to Hyperswitch — they never touch our
            servers.
          </p>
        </div>
      )}

      {selectedMethod && status !== "paid" && (
        <div className="pay-confirm">
          <button
            className="btn btn-primary btn-block"
            disabled={
              status !== "idle" ||
              !elements ||
              !hyperInstance ||
              (needsFieldEntry && !fieldsComplete) ||
              !extraFieldsValid
            }
            onClick={confirm}
          >
            {status === "processing"
              ? "Processing…"
              : status === "loading"
                ? "Preparing…"
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
      {status === "paid" && (
        <div className="status-banner success">
          Payment received.{" "}
          {receiptUrl ? (
            <a href={apiUrl(receiptUrl)} target="_blank" rel="noreferrer">
              View your receipt
            </a>
          ) : (
            "Your receipt is being generated."
          )}
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
          Payment failed — please try again or choose a different method.
        </div>
      )}

      <div className="nav-row">
        <button className="btn btn-ghost" onClick={() => navigate("/review")}>
          ← Back to review
        </button>
      </div>
    </div>
  );
}
