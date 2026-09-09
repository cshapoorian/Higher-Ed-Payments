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
