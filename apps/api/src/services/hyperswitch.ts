import crypto from "node:crypto";
import { env } from "../env.js";

// Thin wrapper around the Hyperswitch REST API (v1).
// Docs: https://docs.hyperswitch.io/api-reference
// TODO: confirm exact request/response shapes against the sandbox once
// HYPERSWITCH_SECRET_KEY is provisioned — this is scaffolding, not verified
// against a live call yet. See ENDPOINTS.md for the endpoint-by-endpoint
// mapping this file implements.

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

export interface SurchargeDetails {
  /** Cents. Maps to surcharge_details.surcharge_amount on POST /payments. */
  surchargeAmountCents: number;
}

export interface CreatePaymentIntentParams {
  amountCents: number;
  currency: string;
  customerId?: string;
  setupFutureUsage?: "on_session" | "off_session";
  /**
   * Our own fee-quote's surcharge, passed through as Hyperswitch's
   * surcharge_details so it shows up as a line item in Hyperswitch's own
   * records instead of just being baked into `amount`. Optional: if this
   * project instead adopts Hyperswitch's Surcharge Decision Manager, this
   * would be dropped in favor of GET /account/payment_methods returning the
   * surcharge computed server-side by Hyperswitch. See ENDPOINTS.md.
   */
  surcharge?: SurchargeDetails;
}

export interface HyperswitchPaymentIntent {
  payment_id: string;
  client_secret: string;
  status: string;
}

/**
 * POST /payments — creates the Payment Intent server-side, scoped to the
 * server-computed balance, with confirm: false so it comes back in
 * requires_payment_method rather than attempting to charge immediately.
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
      surcharge_details: params.surcharge
        ? { surcharge_amount: params.surcharge.surchargeAmountCents }
        : undefined,
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

export interface HyperswitchSavedPaymentMethod {
  payment_method_id: string;
  payment_method: string; // e.g. "card"
  card?: { last4_digits: string; expiry_month: string; expiry_year: string; card_holder_name?: string };
}

/**
 * GET /customers/{customer_id}/payment_methods — the student's saved cards,
 * server-side (secret key), so "Card ending 4242 (saved)" in the UI reflects
 * a real saved method instead of a hardcoded option. Not to be confused with
 * GET /account/payment_methods, which lists methods applicable to a specific
 * payment via client_secret + publishable key for the client SDK — that one
 * matters if this project ever adopts Hyperswitch's Surcharge Decision
 * Manager instead of our own fee-quote logic. See ENDPOINTS.md.
 */
export async function listSavedPaymentMethods(
  customerId: string,
): Promise<HyperswitchSavedPaymentMethod[]> {
  const res = await hyperswitchFetch<{ customer_payment_methods: HyperswitchSavedPaymentMethod[] }>(
    `/customers/${customerId}/payment_methods`,
    { method: "GET" },
  );
  return res.customer_payment_methods;
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

export interface HyperswitchPaymentStatus {
  payment_id: string;
  status: string;
  mandate_id?: string;
}

/**
 * GET /payments/{payment_id}?force_sync=true — a live status check against
 * the connector, not Hyperswitch's last-known cached value. Used to
 * reconcile an order when the terminal webhook hasn't landed yet (see
 * services/orderStatus.ts); without force_sync=true this can return a stale
 * status and mask a payment that already resolved on the connector side.
 */
export async function getPaymentStatus(paymentId: string): Promise<HyperswitchPaymentStatus> {
  return hyperswitchFetch<HyperswitchPaymentStatus>(
    `/payments/${paymentId}?force_sync=true&expand_captures=true&expand_attempts=true`,
    { method: "GET" },
  );
}

// Note: confirming a Payment Intent (POST /payments/{payment_id}/confirm) is
// deliberately NOT wrapped here — it's called by Hyperswitch's client SDK
// from apps/web/src/lib/hyperswitch.ts using the publishable key, so that
// card data and the confirm call never pass through this API. This service
// only ever uses HYPERSWITCH_SECRET_KEY, which must never reach the client.

/**
 * Verifies the signature on an incoming Hyperswitch webhook before trusting
 * it. Hyperswitch signs the raw JSON payload with HMAC using the
 * "payment_response_hash_key" from the dashboard (Developer → Payment
 * Settings) and sends it as x-webhook-signature-512 (SHA-512); older/some
 * event types fall back to x-webhook-signature-256 (SHA-256). Order state
 * only advances on a verified terminal webhook — never on redirect. See §5,
 * step 6.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  headers: { signature512?: string; signature256?: string },
): boolean {
  const hashKey = env.hyperswitch.paymentResponseHashKey;
  if (!hashKey) return false;

  if (headers.signature512) {
    const expected = crypto.createHmac("sha512", hashKey).update(rawBody).digest("hex");
    return safeEqual(expected, headers.signature512);
  }
  if (headers.signature256) {
    const expected = crypto.createHmac("sha256", hashKey).update(rawBody).digest("hex");
    return safeEqual(expected, headers.signature256);
  }
  return false;
}

function safeEqual(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
