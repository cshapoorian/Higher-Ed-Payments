import crypto from "node:crypto";
import { env } from "../env.js";

// Thin wrapper around the Hyperswitch REST API.
// Docs: https://docs.hyperswitch.io/api-reference
// TODO: confirm exact request/response shapes against the sandbox once
// HYPERSWITCH_SECRET_KEY is provisioned — this is scaffolding, not verified
// against a live call yet.

async function hyperswitchFetch<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${env.hyperswitch.baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "api-key": env.hyperswitch.secretKey,
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Hyperswitch ${path} failed: ${res.status} ${body}`);
  }

  return res.json() as Promise<T>;
}

export interface CreatePaymentIntentParams {
  amountCents: number;
  currency: string;
  customerId?: string;
  setupFutureUsage?: "on_session" | "off_session";
}

export interface HyperswitchPaymentIntent {
  payment_id: string;
  client_secret: string;
  status: string;
}

/**
 * Creates a Payment Intent server-side, scoped to the server-computed balance.
 * See architecture §4 ("Server-authoritative Payment Intents").
 */
export async function createPaymentIntent(
  params: CreatePaymentIntentParams,
): Promise<HyperswitchPaymentIntent> {
  return hyperswitchFetch<HyperswitchPaymentIntent>("/payments", {
    method: "POST",
    body: JSON.stringify({
      amount: params.amountCents,
      currency: params.currency,
      customer_id: params.customerId,
      setup_future_usage: params.setupFutureUsage,
      confirm: false,
    }),
  });
}

export interface CreateCustomerParams {
  studentId: string;
  name: string;
  email: string;
}

export interface HyperswitchCustomer {
  customer_id: string;
}

/** One tokenized Hyperswitch Customer per student, reused every term. See §4. */
export async function createCustomer(params: CreateCustomerParams): Promise<HyperswitchCustomer> {
  return hyperswitchFetch<HyperswitchCustomer>("/customers", {
    method: "POST",
    body: JSON.stringify({
      customer_id: params.studentId,
      name: params.name,
      email: params.email,
    }),
  });
}

/**
 * Charges the next installment as a merchant-initiated transaction against a
 * saved mandate. See §4 ("Installments via saved-payment-method mandates").
 */
export async function chargeMandate(mandateId: string, amountCents: number, currency: string) {
  return hyperswitchFetch<HyperswitchPaymentIntent>("/payments", {
    method: "POST",
    body: JSON.stringify({
      amount: amountCents,
      currency,
      mandate_id: mandateId,
      off_session: true,
      confirm: true,
    }),
  });
}

/**
 * Verifies the signature on an incoming Hyperswitch webhook before trusting it.
 * Order state only advances on a verified terminal webhook — never on redirect.
 * See §5, step 6.
 */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !env.hyperswitch.webhookSecret) return false;
  const expected = crypto
    .createHmac("sha256", env.hyperswitch.webhookSecret)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
