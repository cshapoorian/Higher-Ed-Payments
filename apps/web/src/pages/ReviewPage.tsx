import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getMe, priceCart } from "../api";
import { useCart } from "../state/CartContext";

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

  if (!invoice) return <div className="page">Pricing your invoice…</div>;

  return (
    <div className="page">
      <h1>Review your invoice</h1>
      <ul className="line-items">
        {invoice.lineItems.map((item, i) => (
          <li key={i} className={item.kind === "aid_credit" ? "credit" : undefined}>
            <span>{item.description}</span>
            <span>${(item.amountCents / 100).toFixed(2)}</span>
          </li>
        ))}
      </ul>
      <div className="balance-due">
        <strong>Balance due</strong>
        <strong>${(invoice.balanceDueCents / 100).toFixed(2)}</strong>
      </div>
      <div className="nav-row">
        <button onClick={() => navigate("/")}>Back</button>
        <button onClick={() => navigate("/payment")}>Continue to Payment</button>
      </div>
    </div>
  );
}
