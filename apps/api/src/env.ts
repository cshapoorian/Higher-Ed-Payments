import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  // Comma-separated list of allowed web-app origins once this is hosted
  // (e.g. "https://storefront.example.edu"). Unset/"*" allows any origin,
  // which is fine for local dev but should be locked down in production.
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  hyperswitch: {
    baseUrl: required("HYPERSWITCH_BASE_URL", "https://sandbox.hyperswitch.io"),
    secretKey: process.env.HYPERSWITCH_SECRET_KEY ?? "",
    publishableKey: process.env.HYPERSWITCH_PUBLISHABLE_KEY ?? "",
    // Dashboard: Developer → Payment Settings → Webhooks. Signs outgoing
    // webhooks; see verifyWebhookSignature in services/hyperswitch.ts.
    paymentResponseHashKey: process.env.HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY ?? "",
  },
};
