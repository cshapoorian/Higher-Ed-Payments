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
// TODO: verify the exact global name and Elements API against the current
// Hyperswitch SDK docs once a sandbox publishable key is provisioned — this
// scaffolds the Stripe.js-shaped integration pattern, unverified live.

declare global {
  interface Window {
    Hyper?: (publishableKey: string) => HyperInstance;
  }
}

export interface HyperInstance {
  elements: (options: { clientSecret: string }) => HyperElements;
  confirmPayment: (options: {
    elements: HyperElements;
    confirmParams: { return_url: string };
    redirect: "if_required" | "always";
  }) => Promise<{ status: string; error?: { message: string } }>;
}

export interface HyperElement {
  mount: (selector: string) => void;
  // Mirrors Stripe.js Elements' change event — fires with `complete: true`
  // once the field(s) hold a plausibly submittable value. Gates the Confirm
  // button so we never call confirmPayment (and thus never send a card/bank
  // credential to Hyperswitch) before the student has actually entered one.
  // TODO: unverified live — same caveat as the rest of this file.
  on: (event: "change" | "ready", callback: (event: { complete?: boolean }) => void) => void;
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
