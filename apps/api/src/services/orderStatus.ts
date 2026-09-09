import type { Order, PaymentStatus } from "@juspay-takehome/shared";
import { db } from "../db.js";
import { generateReceipt } from "./receipt.js";

interface StatusMapping {
  /**
   * null means "this Hyperswitch status says nothing terminal about the
   * order — leave it where it is". Distinguishing that from "failed" matters:
   * an intent that has been created but not yet confirmed, and an ACH debit
   * waiting on the account holder to authorize a mandate, are both perfectly
   * healthy states that used to be recorded as failures.
   */
  order: Order["status"] | null;
  payment: PaymentStatus;
}

// Hyperswitch's payment statuses, sorted into what each one means for us.
// Anything absent is treated as a failure, which is the safe default for an
// unrecognized terminal state — but the in-flight statuses below must be
// listed explicitly, because defaulting *them* to failed marks live payments
// dead. That is not hypothetical for ACH: a bank debit sits in
// requires_customer_action while the account holder authorizes the mandate,
// and can sit in processing for days afterwards while it clears.
const STATUS_MAP: Record<string, StatusMapping> = {
  // Settled.
  succeeded: { order: "paid", payment: "succeeded" },
  partially_captured: { order: "paid", payment: "succeeded" },
  // Money is moving but hasn't landed. The normal resting state of an ACH
  // debit between submission and settlement.
  processing: { order: "processing", payment: "processing" },
  requires_capture: { order: "processing", payment: "processing" },
  partially_captured_and_capturable: { order: "processing", payment: "processing" },
  // Nothing has been attempted or the payer still has a step to take. The
  // order stays exactly where it is — usually payment_pending.
  requires_payment_method: { order: null, payment: "requires_confirmation" },
  requires_confirmation: { order: null, payment: "requires_confirmation" },
  requires_customer_action: { order: null, payment: "requires_confirmation" },
};

/** Exported for callers (installments.ts) that record a Payment row directly from a synchronous Hyperswitch response instead of going through applyHyperswitchStatus. */
export function mapHyperswitchStatus(hyperswitchStatus: string): StatusMapping {
  return STATUS_MAP[hyperswitchStatus] ?? { order: "failed", payment: "failed" };
}

function toOrderDto(record: {
  id: string;
  invoiceId: string;
  status: string;
  paymentIntentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Order {
  return {
    id: record.id,
    invoiceId: record.invoiceId,
    status: record.status as Order["status"],
    paymentIntentId: record.paymentIntentId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Applies a Hyperswitch payment status to our Order/Payment rows and, on a
 * transition to paid, generates the receipt. Shared by three call sites that
 * all advance the same state machine: the webhook handler (Hyperswitch
 * pushes a verified status), the order-status route (force_sync's directly
 * if our own webhook hasn't landed yet), and — for a *later* installment
 * charge's own webhook — this same path, but scoped to just that Payment row
 * rather than the order as a whole. See architecture §5 step 6, ENDPOINTS.md.
 *
 * Looked up by Payment.hyperswitchPaymentId, not Order.paymentIntentId,
 * because an installment plan produces a new Hyperswitch payment_id per
 * charge (see services/installments and routes/installments.ts) — only the
 * *first* charge's payment_id matches Order.paymentIntentId.
 */
export async function applyHyperswitchStatus(
  paymentId: string,
  hyperswitchStatus: string,
  mandateId?: string,
): Promise<Order | null> {
  const payment = await db.payment.findFirst({ where: { hyperswitchPaymentId: paymentId } });
  if (!payment) return null;

  const { order: nextStatus, payment: paymentStatus } = mapHyperswitchStatus(hyperswitchStatus);
  await db.payment.update({ where: { id: payment.id }, data: { status: paymentStatus } });

  const order = await db.order.findUniqueOrThrow({ where: { id: payment.orderId } });

  // Non-terminal status: the Payment row above now reflects it, but the order
  // keeps whatever it had. Returning early rather than writing null into the
  // status column is the point — see StatusMapping.order.
  if (nextStatus === null) return toOrderDto(order);

  const isPrimaryPayment = order.paymentIntentId === paymentId;

  // A later installment (MIT) charge succeeding/failing doesn't change the
  // order's own status — that already flipped to "paid" (plan established)
  // when the first installment succeeded. Just record it on the Payment row
  // above and stop; the schedule entry itself is updated by whoever
  // initiated the charge (routes/installments.ts).
  if (!isPrimaryPayment) return toOrderDto(order);

  // No-op if we've already recorded this terminal status — keeps this safe
  // to call from both the webhook and a polling force_sync without double-
  // generating a receipt.
  if (order.status === nextStatus) return toOrderDto(order);

  const updated = await db.order.update({ where: { id: order.id }, data: { status: nextStatus } });

  // The first installment charge doubles as a CIT that saves a mandate for
  // the remaining three MIT charges — see architecture §4.
  if (nextStatus === "paid" && mandateId) {
    const plan = await db.installmentPlan.findUnique({ where: { orderId: order.id } });
    if (plan) {
      const schedule = JSON.parse(plan.schedule) as Array<{
        sequence: number;
        dueDate: string;
        amountCents: number;
        paymentId: string | null;
      }>;
      const [first, ...rest] = schedule;
      if (first && !first.paymentId) {
        await db.installmentPlan.update({
          where: { orderId: order.id },
          data: {
            mandateId,
            schedule: JSON.stringify([{ ...first, paymentId: paymentId }, ...rest]),
          },
        });
      }
    }
  }

  if (nextStatus === "paid") {
    const orderDto = toOrderDto(updated);
    const { pdfUrl } = await generateReceipt(orderDto);
    await db.receipt.upsert({
      where: { orderId: updated.id },
      create: { orderId: updated.id, pdfUrl },
      update: { pdfUrl },
    });
  }

  return toOrderDto(updated);
}
