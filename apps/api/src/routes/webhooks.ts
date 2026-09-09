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
    content: { object: { payment_id: string; status: string } };
  };
  const { payment_id: paymentIntentId, status } = event.content.object;

  const record = await db.order.findFirst({ where: { paymentIntentId } });
  if (!record) return res.status(404).json({ error: "order not found" });

  const nextStatus: Order["status"] =
    status === "succeeded" ? "paid" : status === "processing" ? "processing" : "failed";

  const updated = await db.order.update({
    where: { id: record.id },
    data: { status: nextStatus },
  });

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
