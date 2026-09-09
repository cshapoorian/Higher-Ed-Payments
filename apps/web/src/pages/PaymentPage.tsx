import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PaymentMethodType } from "@juspay-takehome/shared";
import { createPaymentIntent } from "../api";
import { loadHyper, type HyperElements } from "../lib/hyperswitch";
import { useCart } from "../state/CartContext";

const METHODS: { type: PaymentMethodType; label: string; hint: string }[] = [
  { type: "card_saved", label: "Card ending 4242 (saved)", hint: "One click, no re-entry" },
  { type: "card_new", label: "New card", hint: "Hosted fields — card data never touches our server" },
  { type: "ach", label: "Bank transfer (ACH)", hint: "No fee" },
  { type: "installment_plan", label: "Split into 4 payments", hint: "Charged automatically every 30 days" },
];

// Confirms directly with Hyperswitch using the client secret from our own
// Payment Intent — card data never touches the storefront API. Order state
// then advances via webhook, not this confirmation call. See architecture §5.
export function PaymentPage() {
  const { invoice, setOrder } = useCart();
  const [status, setStatus] = useState<"idle" | "processing" | "error">("idle");
  const [elements, setElements] = useState<HyperElements | null>(null);
  const navigate = useNavigate();

  if (!invoice) {
    navigate("/review");
    return null;
  }

  async function pay(method: PaymentMethodType) {
    setStatus("processing");
    try {
      const { order, clientSecret, publishableKey } = await createPaymentIntent({
        invoiceId: invoice!.id,
        method,
      });
      setOrder(order);

      const hyper = await loadHyper(publishableKey);
      const els = hyper.elements({ clientSecret });
      setElements(els);

      if (method === "card_new") {
        els.create("card").mount("#hyper-card-element");
        return; // wait for the student to submit the mounted card element
      }

      const result = await hyper.confirmPayment({
        elements: els,
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

  return (
    <div className="page">
      <h1>Pay ${(invoice.balanceDueCents / 100).toFixed(2)}</h1>
      <div className="method-list">
        {METHODS.map((m) => (
          <button key={m.type} disabled={status === "processing"} onClick={() => pay(m.type)}>
            <strong>{m.label}</strong>
            <span>{m.hint}</span>
          </button>
        ))}
      </div>
      {elements && <div id="hyper-card-element" />}
      {status === "processing" && <p>Processing…</p>}
      {status === "error" && <p role="alert">Payment failed — please try again.</p>}
    </div>
  );
}
