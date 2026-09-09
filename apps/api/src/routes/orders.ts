import { Router } from "express";
import type { CreatePaymentIntentRequest, CreatePaymentIntentResponse, Order } from "@juspay-takehome/shared";
import { db } from "../db.js";
import { env } from "../env.js";
import { createPaymentIntent } from "../services/hyperswitch.js";

export const ordersRouter = Router();

// Creates an Order + Hyperswitch Payment Intent scoped to the invoice's
// server-computed balance. Card data never touches this API — the client
// confirms directly with Hyperswitch using the returned client secret.
// See architecture §4 and §5 steps 3–4.
ordersRouter.post("/orders/payment-intent", async (req, res) => {
  const { invoiceId, method } = req.body as CreatePaymentIntentRequest;

  const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });

  const intent = await createPaymentIntent({
    amountCents: invoice.balanceDueCents,
    currency: "USD",
    setupFutureUsage: method === "installment_plan" ? "off_session" : undefined,
  });

  const record = await db.order.upsert({
    where: { invoiceId },
    create: {
      invoiceId,
      status: "payment_pending",
      paymentIntentId: intent.payment_id,
    },
    update: {
      status: "payment_pending",
      paymentIntentId: intent.payment_id,
    },
  });

  const order: Order = {
    id: record.id,
    invoiceId: record.invoiceId,
    status: record.status as Order["status"],
    paymentIntentId: record.paymentIntentId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };

  const response: CreatePaymentIntentResponse = {
    order,
    clientSecret: intent.client_secret,
    publishableKey: env.hyperswitch.publishableKey,
  };
  res.json(response);
});
