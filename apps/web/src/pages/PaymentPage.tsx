import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PaymentMethodQuote, PaymentMethodType, SavedPaymentMethod, Term } from "@juspay-takehome/shared";
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
}

const ALWAYS_AVAILABLE_METHODS: MethodMeta[] = [
  { type: "card_new", label: "New card" },
  { type: "ach", label: "Bank transfer (ACH)" },
  { type: "installment_plan", label: "Split into 4 payments" },
];

// "Card ending 4242 (saved)" is only ever shown when GET /api/payment-methods
// actually returns a saved Hyperswitch payment method for this student — see
// ENDPOINTS.md. Note this still confirms through the same hosted-fields flow
// as "New card" today; a true one-click charge against the stored token
// would need a separate confirm path and isn't wired up (see the report at
// the end of this work for why).
function savedCardMethod(saved: SavedPaymentMethod): MethodMeta {
  return { type: "card_saved", label: `Card ending ${saved.last4} (saved)` };
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
  const [status, setStatus] = useState<"idle" | "loading" | "processing" | "paid" | "timeout" | "error">("idle");
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [savedMethod, setSavedMethod] = useState<SavedPaymentMethod | null>(null);
  const [term, setTerm] = useState<Term | null>(null);
  // Only card_new and ach mount a field-collection widget below; both start
  // false so Confirm stays disabled until the student has actually entered
  // something. card_saved/installment_plan never gate on this.
  const [fieldsComplete, setFieldsComplete] = useState(false);
  const cardMountRef = useRef<HTMLDivElement>(null);
  const needsFieldEntry = selectedMethod === "card_new" || selectedMethod === "ach";

  const METHODS = useMemo<MethodMeta[]>(
    () => (savedMethod ? [savedCardMethod(savedMethod), ...ALWAYS_AVAILABLE_METHODS] : ALWAYS_AVAILABLE_METHODS),
    [savedMethod],
  );

  useEffect(() => {
    getMe().then(({ student, term }) => {
      setTerm(term);
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
    setStatus("processing");
    try {
      const result = await hyperInstance.confirmPayment({
        elements,
        confirmParams: { return_url: window.location.href },
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
            <div className="method-name">{m.label}</div>
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

      {needsFieldEntry && <div id="hyper-payment-element" ref={cardMountRef} />}

      {selectedMethod && status !== "paid" && (
        <div className="pay-confirm">
          <button
            className="btn btn-primary btn-block"
            disabled={status !== "idle" || !elements || !hyperInstance || (needsFieldEntry && !fieldsComplete)}
            onClick={confirm}
          >
            {status === "processing"
              ? "Processing…"
              : status === "loading"
                ? "Preparing…"
                : `Confirm & pay ${selectedQuote ? formatUsd(selectedQuote.totalCents) : ""}`}
          </button>
          <p className="pay-footnote">Refund & cancellation policy · Itemized PDF receipt</p>
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
