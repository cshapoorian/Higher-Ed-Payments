// Loads Hyperswitch's client SDK (hosted fields) the same way Stripe.js is
// loaded — a global script tag exposing window.Hyper. Hosted fields keep
// card data off the storefront API entirely, so PCI scope stays at SAQ-A.
// See architecture §4 ("Hosted card fields, not raw HTML inputs").
//
// confirmPayment() below calls Hyperswitch's POST /payments/{payment_id}/confirm
// under the hood, authenticated with the publishableKey passed into
// loadHyper — never the secret key, which lives only in apps/api and must
// never reach this file. It attempts authorization with the processor and
// lands on succeeded, requires_capture, or failed.
//
// Verified live 2026-09-09 against beta.hyperswitch.io/v1/HyperLoader.js:
//   - the global really is window.Hyper
//   - elements.create("card") mounts one iframe (componentName=card) holding
//     card number + MM/YY + CVC, and those fields do accept input
//   - the element emits "ready", "focus" and "blur" ONLY. It does NOT emit a
//     Stripe-style "change" event carrying { complete }. Gating a Pay button
//     on such an event leaves it disabled forever — validity is reported by
//     confirmPayment() rejecting instead, so surface that error to the user.
//
// Note the SDK is served from a DIFFERENT host than the REST API:
// sandbox.hyperswitch.io serves the API but 404s on HyperLoader.js.

declare global {
  interface Window {
    Hyper?: (publishableKey: string) => HyperInstance;
  }
}

export interface BillingDetails {
  name?: string;
  email?: string;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    country?: string;
  };
}

export interface HyperInstance {
  elements: (options: { clientSecret: string }) => HyperElements;
  confirmPayment: (options: {
    elements: HyperElements;
    confirmParams: {
      return_url: string;
      // Billing address (card) / account-holder name (ACH) collected as plain
      // inputs here — neither is cardholder data, so it doesn't need to go
      // through a hosted field. It rides alongside the hosted element's own
      // (PAN/routing/account) payload straight to Hyperswitch.
      payment_method_data?: { billing_details?: BillingDetails };
    };
    redirect: "if_required" | "always";
  }) => Promise<{ status: string; error?: { message: string } }>;
}

export interface HyperElement {
  mount: (selector: string) => void;
  // "ready" fires once the hosted iframe has painted its inputs — that's the
  // signal we use to swap the skeleton out for the live field. "focus"/"blur"
  // also fire. There is deliberately no "change" here: the SDK doesn't emit
  // one (verified live), so per-keystroke validity is not observable and the
  // Pay button must not depend on it.
  on: (event: "ready" | "focus" | "blur", callback: (event: unknown) => void) => void;
}

export interface HyperElements {
  create: (type: "payment" | "card") => HyperElement;
}

let loadPromise: Promise<HyperInstance> | null = null;

export function loadHyper(publishableKey: string): Promise<HyperInstance> {
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const existing = window.Hyper;
    if (existing) {
      resolve(existing(publishableKey));
      return;
    }

    const script = document.createElement("script");
    script.src = import.meta.env.VITE_HYPERSWITCH_SDK_URL;
    script.async = true;
    script.onload = () => {
      if (!window.Hyper) {
        reject(new Error("Hyperswitch SDK loaded but window.Hyper is undefined"));
        return;
      }
      resolve(window.Hyper(publishableKey));
    };
    script.onerror = () => reject(new Error("Failed to load Hyperswitch SDK"));
    document.head.appendChild(script);
  });

  return loadPromise;
}

// --- ACH (bank debit) ---------------------------------------------------
//
// ACH does not go through the hosted-fields SDK. There is no ACH element to
// mount on this account: elements.create("payment") renders a *card* form
// here (verified live), which under a "Link your bank" heading would invite a
// student to type a PAN into what they believe is a bank transfer. So the
// routing/account numbers are ordinary labelled inputs and this function
// POSTs them to Hyperswitch's confirm endpoint directly.
//
// That is a deliberate, and narrower, exception to "confirm through the SDK":
//   - Bank account numbers are not cardholder data. They sit outside PCI's
//     SAQ-A scope, so the reason hosted fields exist for cards doesn't apply.
//   - The request still goes browser → Hyperswitch. It never transits
//     apps/api, so the API's PCI/data posture is unchanged.
//   - It authenticates with the publishable key, exactly as the SDK does.
//     The secret key must never reach this file.
//
// Verified live 2026-09-09 against sandbox.hyperswitch.io: the publishable
// key is accepted on this endpoint, and Hyperswitch deserializes the
// ach_bank_debit object below strictly — dropping or renaming
// `routing_number` returns IR_06 "Json deserialize error: missing field
// `routing_number`", while the shape below passes deserialization and reaches
// connector routing. What could NOT be verified end to end is a successful
// ACH authorization, because no connector on this sandbox account implements
// bank_debit — see TEST_CREDENTIALS.md for the full evidence.

export interface AchBankDetails {
  accountHolderName: string;
  routingNumber: string;
  accountNumber: string;
  accountType: "checking" | "savings";
}

export interface ConfirmAchParams {
  hyperswitchBaseUrl: string;
  publishableKey: string;
  paymentId: string;
  clientSecret: string;
  bank: AchBankDetails;
  billingDetails: BillingDetails;
}

export interface ConfirmAchResult {
  /** Hyperswitch payment status: "processing" is the ACH happy path. */
  status: string;
}

interface HyperswitchErrorBody {
  error?: { code?: string; message?: string; reason?: string };
  error_code?: string;
  error_message?: string;
  status?: string;
}

// Hyperswitch's own error strings are written for integrators, not students.
// Two of them are worth translating because they describe the *account*, not
// anything the student did, and both were seen live on this sandbox:
//   IR_39 — no connector has bank_debit enabled
//   IR_19 — a connector has it enabled but its integration can't do it
// Anything else (a real bank decline, a malformed account) is passed through,
// since that text is actionable.
function achErrorMessage(body: HyperswitchErrorBody): string {
  const code = body.error?.code ?? body.error_code;
  const message = body.error?.reason ?? body.error?.message ?? body.error_message;

  if (code === "IR_39" || code === "IR_19") {
    return "Bank transfers aren't enabled on this account, so this payment can't be taken. Pay by card instead.";
  }
  return message || "The bank transfer was declined.";
}

/**
 * POST /payments/{payment_id}/confirm with a bank_debit/ach payment method.
 *
 * Resolves with Hyperswitch's status. Note that the ACH success case is
 * "processing", not "succeeded": an ACH debit is submitted to the network and
 * settles over the following business days, so there is no synchronous
 * authorization the way there is for a card. Order state still only advances
 * on the verified webhook — this status is for what the student is shown.
 */
export async function confirmAchPayment(params: ConfirmAchParams): Promise<ConfirmAchResult> {
  const res = await fetch(
    `${params.hyperswitchBaseUrl}/payments/${params.paymentId}/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": params.publishableKey },
      body: JSON.stringify({
        client_secret: params.clientSecret,
        payment_method: "bank_debit",
        payment_method_type: "ach",
        payment_method_data: {
          bank_debit: {
            ach_bank_debit: {
              billing_details: params.billingDetails,
              account_number: params.bank.accountNumber,
              routing_number: params.bank.routingNumber,
              bank_account_holder_name: params.bank.accountHolderName,
              bank_type: params.bank.accountType,
              bank_holder_type: "personal",
            },
          },
        },
      }),
    },
  );

  const body = (await res.json().catch(() => ({}))) as HyperswitchErrorBody;
  if (!res.ok || body.error) throw new Error(achErrorMessage(body));
  // Hyperswitch can return 200 with a terminal failure rather than an error
  // object — a bank decline arrives this way, not as a 4xx.
  if (body.status === "failed") throw new Error(achErrorMessage(body));

  return { status: body.status ?? "processing" };
}

/**
 * ABA routing-number check digit (the last of the nine).
 *
 * This is worth doing client-side because it is the one ACH input error we
 * can catch for free, before a network call and before the student's account
 * is touched: a mistyped routing number that passes the checksum will be
 * rejected days later by the bank, but a typo that *fails* it is provably
 * wrong right now. Account numbers have no equivalent check — length is all
 * we can assert — which is why only this one gets a real validator.
 */
export function isValidRoutingNumber(routingNumber: string): boolean {
  if (!/^\d{9}$/.test(routingNumber)) return false;
  const d = [...routingNumber].map(Number);
  const checksum =
    3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + 1 * (d[2] + d[5] + d[8]);
  return checksum % 10 === 0;
}
