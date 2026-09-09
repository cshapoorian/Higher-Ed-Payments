import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PaymentMethodQuote, PaymentMethodType } from "@juspay-takehome/shared";
import { createPaymentIntent, quotePayment } from "../api";
import { loadHyper, type HyperElements, type HyperInstance } from "../lib/hyperswitch";
import { useCart } from "../state/CartContext";

interface MethodMeta {
  type: PaymentMethodType;
  label: string;
  hint: string;
  icon: string;
  group: "Self-pay" | "Payment plan";
}

const METHODS: MethodMeta[] = [
  {
    type: "card_saved",
    label: "Card ending 4242",
    hint: "Saved on file — one click, no re-entry",
    icon: "💳",
    group: "Self-pay",
  },
  {
    type: "card_new",
    label: "New card",
    hint: "Hosted fields — card data never touches our server",
    icon: "➕",
    group: "Self-pay",
  },
  {
    type: "ach",
    label: "Bank transfer (ACH)",
    hint: "Funds move directly from your bank account",
    icon: "🏦",
    group: "Self-pay",
  },
  {
    type: "installment_plan",
    label: "Split into 4 payments",
    hint: "Merchant-financed plan, charged automatically every 30 days",
    icon: "📆",
    group: "Payment plan",
  },
];

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
  const { invoice, setOrder } = useCart();
  const navigate = useNavigate();

  const [quotes, setQuotes] = useState<Partial<Record<PaymentMethodType, PaymentMethodQuote>>>({});
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodType | null>(null);
  const [hyperInstance, setHyperInstance] = useState<HyperInstance | null>(null);
  const [elements, setElements] = useState<HyperElements | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "processing" | "error">("idle");
  const cardMountRef = useRef<HTMLDivElement>(null);

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
  }, [invoice]);

  useEffect(() => {
    if (selectedMethod === "card_new" && elements && cardMountRef.current) {
      elements.create("card").mount("#hyper-card-element");
    }
  }, [selectedMethod, elements]);

  if (!invoice) {
    navigate("/review");
    return null;
  }

  async function selectMethod(method: PaymentMethodType) {
    if (selectedMethod === method) return;
    setSelectedMethod(method);
    setElements(null);
    setHyperInstance(null);
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
    setStatus("processing");
    try {
      const result = await hyperInstance.confirmPayment({
        elements,
        confirmParams: { return_url: window.location.href },
        redirect: "if_required",
      });
      if (result.error) throw new Error(result.error.message);
      // Terminal status is set by the webhook, not here — see architecture §5 step 6.
      setStatus("idle");
    } catch (err) {
      console.error(err);
      setStatus("error");
    }
  }

  const selectedQuote = selectedMethod ? quotes[selectedMethod] : undefined;
  const selfPayMethods = METHODS.filter((m) => m.group === "Self-pay");
  const planMethods = METHODS.filter((m) => m.group === "Payment plan");

  function renderMethodCard(m: MethodMeta) {
    const quote = quotes[m.type];
    const isSelected = selectedMethod === m.type;
    return (
      <button
        key={m.type}
        className={`card method-card ${isSelected ? "is-selected" : ""}`}
        disabled={status === "processing"}
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
            <strong>{quote ? formatUsd(quote.totalCents) : formatUsd(invoice!.balanceDueCents)}</strong>
            {quote && (
              <span className={`fee-pill ${quote.feeCents === 0 ? "free" : "surcharge"}`}>
                {quote.feeCents === 0 ? "No fee" : `+${formatUsd(quote.feeCents)} fee`}
              </span>
            )}
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
        <h1>Choose how to pay</h1>
        <p>ACH is free. Card payments — including the installment plan — carry a processing fee, shown up front.</p>
      </div>

      <div className="method-section-label">{selfPayMethods[0].group}</div>
      <div className="method-list">{selfPayMethods.map(renderMethodCard)}</div>

      <div className="method-section-label">{planMethods[0].group}</div>
      <div className="method-list">{planMethods.map(renderMethodCard)}</div>

      {selectedMethod === "card_new" && (
        <div id="hyper-card-element" ref={cardMountRef} />
      )}

      {selectedMethod && (
        <div className="pay-confirm">
          <button
            className="btn btn-primary btn-block"
            disabled={status !== "idle" || !elements || !hyperInstance}
            onClick={confirm}
          >
            {status === "processing"
              ? "Processing…"
              : status === "loading"
                ? "Preparing…"
                : `Pay ${selectedQuote ? formatUsd(selectedQuote.totalCents) : ""}`}
          </button>
        </div>
      )}

      {status === "processing" && <div className="status-banner processing">Processing your payment…</div>}
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
