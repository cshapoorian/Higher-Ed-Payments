import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  hyperswitch: {
    baseUrl: required("HYPERSWITCH_BASE_URL", "https://sandbox.hyperswitch.io"),
    secretKey: process.env.HYPERSWITCH_SECRET_KEY ?? "",
    publishableKey: process.env.HYPERSWITCH_PUBLISHABLE_KEY ?? "",
    webhookSecret: process.env.HYPERSWITCH_WEBHOOK_SECRET ?? "",
  },
};
