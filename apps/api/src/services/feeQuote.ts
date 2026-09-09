import type { InstallmentScheduleEntry, PaymentMethodQuote, PaymentMethodType } from "@juspay-takehome/shared";

// Fee-differentiated payment methods: ACH is free, card carries a surcharge,
// and the merchant-financed installment plan (card-mandate backed) carries
// the same surcharge spread across the schedule. See
// project-description-architecture.md §2 and §4. This is the single place
// that turns a balance into what a given method actually charges — the
// payment-intent route below must derive its amount from here too, never
// from a client-supplied total.
const CARD_SURCHARGE_RATE = 0.029; // 2.9%, typical card-not-present interchange pass-through
const INSTALLMENT_COUNT = 4;
const INSTALLMENT_INTERVAL_DAYS = 30;

function centsRoundedHalfUp(value: number): number {
  return Math.round(value);
}

function buildInstallmentSchedule(totalCents: number): InstallmentScheduleEntry[] {
  const base = Math.floor(totalCents / INSTALLMENT_COUNT);
  const remainder = totalCents - base * INSTALLMENT_COUNT;

  return Array.from({ length: INSTALLMENT_COUNT }, (_, i) => {
    const sequence = i + 1;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + i * INSTALLMENT_INTERVAL_DAYS);
    // First entry absorbs the rounding remainder so the schedule sums exactly.
    const amountCents = sequence === 1 ? base + remainder : base;
    return { sequence, dueDate: dueDate.toISOString(), amountCents, paymentId: null };
  });
}

export function quoteForMethod(balanceDueCents: number, method: PaymentMethodType): PaymentMethodQuote {
  if (method === "ach") {
    return {
      method,
      balanceDueCents,
      feeCents: 0,
      feeLabel: "No fee — funds move directly from your bank account",
      totalCents: balanceDueCents,
    };
  }

  const feeCents = centsRoundedHalfUp(balanceDueCents * CARD_SURCHARGE_RATE);
  const totalCents = balanceDueCents + feeCents;

  if (method === "installment_plan") {
    return {
      method,
      balanceDueCents,
      feeCents,
      feeLabel: `${(CARD_SURCHARGE_RATE * 100).toFixed(1)}% card processing fee, split across ${INSTALLMENT_COUNT} payments`,
      totalCents,
      installmentSchedule: buildInstallmentSchedule(totalCents),
    };
  }

  // card_new / card_saved
  return {
    method,
    balanceDueCents,
    feeCents,
    feeLabel: `${(CARD_SURCHARGE_RATE * 100).toFixed(1)}% card processing fee`,
    totalCents,
  };
}
