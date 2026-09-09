import type { Order, PaymentStatus } from "@juspay-takehome/shared";
import { db } from "../db.js";
import { generateReceipt } from "./receipt.js";

interface StatusMapping {
  order: Order["status"];
  payment: PaymentStatus;
}

const STATUS_MAP: Record<string, StatusMapping> = {
  succeeded: { order: "paid", payment: "succeeded" },
  processing: { order: "processing", payment: "processing" },
};

function mapStatus(hyperswitchStatus: string): StatusMapping {
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
 * transition to paid, generates the receipt. Shared by two call sites that
 * both need to advance the same state machine: the webhook handler
 * (Hyperswitch pushes a verified terminal status) and the order-status route
 * (the client pulls, and we force_sync Hyperswitch directly if our own
 * webhook hasn't landed yet). See architecture §5 step 6 and ENDPOINTS.md.
 */
export async function applyHyperswitchStatus(
  paymentIntentId: string,
  hyperswitchStatus: string,
  mandateId?: string,
): Promise<Order | null> {
  const record = await db.order.findFirst({ where: { paymentIntentId } });
  if (!record) return null;

  const { order: nextStatus, payment: paymentStatus } = mapStatus(hyperswitchStatus);

  // No-op if we've already recorded this terminal status — keeps this safe
  // to call from both the webhook and a polling force_sync without double-
  // generating a receipt.
  if (record.status === nextStatus) return toOrderDto(record);

  const updated = await db.order.update({ where: { id: record.id }, data: { status: nextStatus } });

  await db.payment.updateMany({
    where: { orderId: record.id, hyperswitchPaymentId: paymentIntentId },
    data: { status: paymentStatus },
  });

  // The first installment charge doubles as a CIT that saves a mandate for
  // the remaining three MIT charges — see architecture §4.
  if (nextStatus === "paid" && mandateId) {
    const plan = await db.installmentPlan.findUnique({ where: { orderId: record.id } });
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
          where: { orderId: record.id },
          data: {
            mandateId,
            schedule: JSON.stringify([{ ...first, paymentId: paymentIntentId }, ...rest]),
          },
        });
      }
    }
  }

  if (nextStatus === "paid") {
    const order = toOrderDto(updated);
    const { pdfUrl } = await generateReceipt(order);
    await db.receipt.upsert({
      where: { orderId: updated.id },
      create: { orderId: updated.id, pdfUrl },
      update: { pdfUrl },
    });
  }

  return toOrderDto(updated);
}
