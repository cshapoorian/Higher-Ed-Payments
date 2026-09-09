// Loads Hyperswitch's client SDK (hosted fields) the same way Stripe.js is
// loaded — a global script tag exposing window.Hyper. Hosted fields keep
// card data off the storefront API entirely, so PCI scope stays at SAQ-A.
// See architecture §4 ("Hosted card fields, not raw HTML inputs").
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

export interface HyperElements {
  create: (type: "payment" | "card") => { mount: (selector: string) => void };
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
