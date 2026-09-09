import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { InvoiceLineItem } from "@juspay-takehome/shared";
import { getMe, priceCart } from "../api";
import { useCart } from "../state/CartContext";

function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}${(Math.abs(cents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}`;
}

const GROUP_LABELS: Record<InvoiceLineItem["kind"], string> = {
  tuition: "Tuition",
  fee: "Fees",
  aid_credit: "Financial aid",
};

// The invoice source of truth: tuition + fees, minus aid credit, producing a
// server-computed balance due the client never overrides. See architecture §3.
export function ReviewPage() {
  const { selectedSectionIds, invoice, setInvoice } = useCart();
  const navigate = useNavigate();

  useEffect(() => {
    if (selectedSectionIds.length === 0) {
      navigate("/");
      return;
    }
    getMe().then(({ student, term }) =>
      priceCart({ studentId: student.id, termId: term.id, courseSectionIds: selectedSectionIds }).then(
        (res) => setInvoice(res.invoice),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSectionIds]);

  if (!invoice) {
    return (
      <div>
        <div className="page-head">
          <span className="eyebrow">Step 2 of 3</span>
          <h1>Review your invoice</h1>
        </div>
        <div className="loading-state">Pricing your invoice…</div>
      </div>
    );
  }

  const groups: { kind: InvoiceLineItem["kind"]; items: InvoiceLineItem[] }[] = (
    ["tuition", "fee", "aid_credit"] as const
  )
    .map((kind) => ({ kind, items: invoice.lineItems.filter((item) => item.kind === kind) }))
    .filter((g) => g.items.length > 0);

  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Step 2 of 3</span>
        <h1>Review your invoice</h1>
        <p>Every line below is priced by Student Financial Services — nothing here is editable client-side.</p>
      </div>

      <div className="card invoice-card">
        {groups.map((group) => (
          <div className="invoice-group" key={group.kind}>
            <div className="invoice-group-label">{GROUP_LABELS[group.kind]}</div>
            <ul className="line-items">
              {group.items.map((item, i) => (
                <li key={i} className={item.kind === "aid_credit" ? "credit" : undefined}>
                  <span>{item.description}</span>
                  <span>{formatUsd(item.amountCents)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <div className="invoice-divider" />

        <div className="balance-due">
          <span className="label">Balance due</span>
          <span className="amount">{formatUsd(invoice.balanceDueCents)}</span>
        </div>
        <p className="balance-note">
          Computed server-side from your term's tuition, fees, and aid credits — this is the amount that will be
          charged, before any payment-method fee shown on the next step.
        </p>
      </div>

      <div className="nav-row">
        <button className="btn btn-ghost" onClick={() => navigate("/")}>
          ← Back to courses
        </button>
        <button className="btn btn-primary" onClick={() => navigate("/payment")}>
          Continue to Payment
        </button>
      </div>
    </div>
  );
}
