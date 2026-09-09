import { Router } from "express";
import type {
  CreatePaymentIntentRequest,
  CreatePaymentIntentResponse,
  GetOrderResponse,
  Order,
  QuotePaymentRequest,
  QuotePaymentResponse,
} from "@juspay-takehome/shared";
import { db } from "../db.js";
import { env } from "../env.js";
import { quoteForMethod } from "../services/feeQuote.js";
import { createPaymentIntent, getPaymentStatus } from "../services/hyperswitch.js";
import { applyHyperswitchStatus } from "../services/orderStatus.js";

export const ordersRouter = Router();

// Server-computed fee quote for a given method — ACH free, card/installment
// surcharged. The client renders this and only this; it never derives a
// total client-side. See architecture §2, §4.
//
// This never calls Hyperswitch — quoteForMethod is our own pricing logic.
// The quote's feeCents is what gets handed to POST /orders/payment-intent
// below as Hyperswitch's surcharge_details.surcharge_amount. (The
// alternative — letting Hyperswitch compute this via its Surcharge Decision
// Manager, exposed to the client SDK through GET /account/payment_methods —
// isn't used here since the fee rule is simple enough to own directly.)
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
    surcharge: quote.feeCents > 0 ? { surchargeAmountCents: quote.feeCents } : undefined,
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

// Order state only advances on a verified Hyperswitch webhook (webhooks.ts),
// never on the client's redirect/confirmPayment result — so after confirming
// with Hyperswitch, the client polls here to learn the real terminal status.
// See architecture §3, §5 step 6.
//
// While the order is still non-terminal, this also force_syncs directly
// against GET /payments/{id}?force_sync=true and reconciles through the same
// path the webhook uses. Without force_sync=true a status check can return
// Hyperswitch's last-known cached value instead of a live check with the
// connector — exactly the gap that would otherwise show up as the client
// polling forever on a payment that already resolved but whose webhook was
// delayed or dropped.
ordersRouter.get("/orders/:id", async (req, res) => {
  let record = await db.order.findUnique({
    where: { id: req.params.id },
    include: { receipt: true },
  });
  if (!record) return res.status(404).json({ error: "order not found" });

  const isTerminal = record.status === "paid" || record.status === "failed";
  const paymentIntentId = record.paymentIntentId;
  if (!isTerminal && paymentIntentId) {
    try {
      const live = await getPaymentStatus(paymentIntentId);
      await applyHyperswitchStatus(paymentIntentId, live.status, live.mandate_id);
      record = await db.order.findUnique({ where: { id: req.params.id }, include: { receipt: true } });
    } catch (err) {
      // Hyperswitch unreachable or not yet configured — fall back to our
      // last webhook-derived status rather than fail the poll outright.
      console.error(`force_sync failed for payment ${paymentIntentId}:`, err);
    }
  }
  if (!record) return res.status(404).json({ error: "order not found" });

  const order: Order = {
    id: record.id,
    invoiceId: record.invoiceId,
    status: record.status as Order["status"],
    paymentIntentId: record.paymentIntentId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };

  const response: GetOrderResponse = {
    order,
    receiptUrl: record.receipt?.pdfUrl ?? null,
  };
  res.json(response);
});
