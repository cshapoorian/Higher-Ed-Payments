import { Router } from "express";
import type { Order } from "@juspay-takehome/shared";
import { db } from "../db.js";
import { verifyWebhookSignature } from "../services/hyperswitch.js";
import { generateReceipt } from "../services/receipt.js";

export const webhooksRouter = Router();

// Order state only advances here, on a verified server-to-server webhook —
// never on client redirect. A closed tab or dropped connection can't fake a
// completed payment. See architecture §3 and §5 step 6.
// NOTE: mounted with express.raw() in index.ts so req.body is the raw Buffer
// needed for signature verification.
webhooksRouter.post("/hyperswitch", async (req, res) => {
  const signature = req.header("x-webhook-signature");
  const rawBody = req.body as Buffer;

  if (!verifyWebhookSignature(rawBody, signature)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  const event = JSON.parse(rawBody.toString("utf8")) as {
    content: { object: { payment_id: string; status: string; mandate_id?: string } };
  };
  const { payment_id: paymentIntentId, status, mandate_id: mandateId } = event.content.object;

  const record = await db.order.findFirst({ where: { paymentIntentId } });
  if (!record) return res.status(404).json({ error: "order not found" });

  const nextStatus: Order["status"] =
    status === "succeeded" ? "paid" : status === "processing" ? "processing" : "failed";
  const paymentStatus = status === "succeeded" ? "succeeded" : status === "processing" ? "processing" : "failed";

  const updated = await db.order.update({
    where: { id: record.id },
    data: { status: nextStatus },
  });

  await db.payment.updateMany({
    where: { orderId: record.id, hyperswitchPaymentId: paymentIntentId },
    data: { status: paymentStatus },
  });

  // The first installment charge doubles as a CIT that saves a mandate for
  // the remaining three MIT charges — see architecture §4. Record the
  // mandate once Hyperswitch reports it, and mark this schedule entry paid.
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
    const { pdfUrl } = await generateReceipt({
      id: updated.id,
      invoiceId: updated.invoiceId,
      status: updated.status as Order["status"],
      paymentIntentId: updated.paymentIntentId,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
    await db.receipt.upsert({
      where: { orderId: updated.id },
      create: { orderId: updated.id, pdfUrl },
      update: { pdfUrl },
    });
  }

  res.json({ received: true });
});
