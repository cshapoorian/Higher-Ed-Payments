import { Router } from "express";
import type {
  CreatePaymentIntentRequest,
  CreatePaymentIntentResponse,
  Order,
  QuotePaymentRequest,
  QuotePaymentResponse,
} from "@juspay-takehome/shared";
import { db } from "../db.js";
import { env } from "../env.js";
import { quoteForMethod } from "../services/feeQuote.js";
import { createPaymentIntent } from "../services/hyperswitch.js";

export const ordersRouter = Router();

// Server-computed fee quote for a given method — ACH free, card/installment
// surcharged. The client renders this and only this; it never derives a
// total client-side. See architecture §2, §4.
ordersRouter.post("/orders/quote", async (req, res) => {
  const { invoiceId, method } = req.body as QuotePaymentRequest;

  const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const quote = quoteForMethod(invoice.balanceDueCents, method);

  const response: QuotePaymentResponse = { quote };
  res.json(response);
});

// Creates an Order + Hyperswitch Payment Intent scoped to the fee-inclusive
// quote for the chosen method. Card data never touches this API — the client
// confirms directly with Hyperswitch using the returned client secret.
// See architecture §4 and §5 steps 3–4.
ordersRouter.post("/orders/payment-intent", async (req, res) => {
  const { invoiceId, method } = req.body as CreatePaymentIntentRequest;

  const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const quote = quoteForMethod(invoice.balanceDueCents, method);

  const intent = await createPaymentIntent({
    amountCents: quote.totalCents,
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

  await db.payment.create({
    data: {
      orderId: record.id,
      hyperswitchPaymentId: intent.payment_id,
      method,
      status: "requires_confirmation",
      amountCents: quote.totalCents,
    },
  });

  if (method === "installment_plan" && quote.installmentSchedule) {
    await db.installmentPlan.upsert({
      where: { orderId: record.id },
      create: {
        orderId: record.id,
        installmentCount: quote.installmentSchedule.length,
        intervalDays: 30,
        schedule: JSON.stringify(quote.installmentSchedule),
      },
      update: {
        installmentCount: quote.installmentSchedule.length,
        intervalDays: 30,
        schedule: JSON.stringify(quote.installmentSchedule),
      },
    });
  }

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
    quote,
  };
  res.json(response);
});
