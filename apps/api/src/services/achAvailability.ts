import type { PaymentMethodAvailability } from "@juspay-takehome/shared";
import { env } from "../env.js";
import {
  getConnectorFeatureMatrix,
  listConnectors,
  type FeatureMatrixConnector,
  type HyperswitchConnector,
} from "./hyperswitch.js";

// Can ACH actually be charged on the merchant account this API is pointed at?
//
// This used to be a hardcoded `achUnavailable` constant in the web app with a
// comment telling the next person to flip it by hand. That is exactly the
// kind of fact that goes stale silently: it is a property of the *account*,
// not of this codebase, and it changes the moment someone adds a connector in
// the Hyperswitch dashboard. So we ask Hyperswitch instead.
//
// Two independent things both have to be true, and each one fails differently
// at confirm time (both verified live against this sandbox, 2026-09-09):
//
//   1. Some active connector on the profile must have bank_debit/ach enabled.
//      Otherwise confirm returns IR_39, "No eligible connector was found for
//      the current payment method configuration".
//
//   2. That connector's integration must actually implement bank_debit/ach.
//      Enabling the method on a connector that cannot do it succeeds at the
//      config layer — POST /account/{mid}/connectors returns 200 — and only
//      blows up at confirm with IR_19, "The payment method bank_debit is not
//      supported by <connector>". All four connectors on this sandbox profile
//      (fauxpay, paypal_test, stripe_test, pretendpay) are Hyperswitch dummy
//      connectors and fail this second test.
//
// Checking only (1) would light the ACH button up for a merchant whose
// payment would then fail on submit, which is worse than not offering it.

const ACH_PAYMENT_METHOD = "bank_debit";
const ACH_PAYMENT_METHOD_TYPE = "ach";

// Connector config changes by hand in a dashboard, not per request. Cache so
// a student loading the payment step doesn't cost two Hyperswitch round trips.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { at: number; value: PaymentMethodAvailability } | null = null;

function supportsAch(connector: HyperswitchConnector): boolean {
  return (connector.payment_methods_enabled ?? []).some(
    (pm) =>
      pm.payment_method === ACH_PAYMENT_METHOD &&
      (pm.payment_method_types ?? []).some((t) => t.payment_method_type === ACH_PAYMENT_METHOD_TYPE),
  );
}

function integrationSupportsAch(entry: FeatureMatrixConnector): boolean {
  return (entry.supported_payment_methods ?? []).some(
    (pm) =>
      pm.payment_method === ACH_PAYMENT_METHOD &&
      pm.payment_method_type === ACH_PAYMENT_METHOD_TYPE,
  );
}

const UNAVAILABLE_REASON =
  "Bank transfers aren't available on this account yet — pay by card instead.";

/**
 * Resolves whether ACH is chargeable, with an operator-facing `detail` that
 * names the specific gap rather than a generic "not configured". Never
 * throws: if Hyperswitch can't be reached (or HYPERSWITCH_MERCHANT_ID isn't
 * set) it reports unavailable and says so, because offering a method we
 * cannot verify is the failure mode this whole function exists to prevent.
 */
export async function getAchAvailability(): Promise<PaymentMethodAvailability> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const value = await resolveAchAvailability();
  cached = { at: Date.now(), value };
  return value;
}

/** Test/ops hook: drop the cache after changing connector config. */
export function clearAchAvailabilityCache(): void {
  cached = null;
}

async function resolveAchAvailability(): Promise<PaymentMethodAvailability> {
  if (!env.hyperswitch.merchantId) {
    return {
      available: false,
      reason: UNAVAILABLE_REASON,
      detail:
        "HYPERSWITCH_MERCHANT_ID is not set, so this API cannot read the merchant's " +
        "connector configuration to confirm ACH is chargeable. Set it in apps/api/.env " +
        "(see .env.example) — it is not a secret.",
    };
  }

  let connectors: HyperswitchConnector[];
  let matrix: FeatureMatrixConnector[];
  try {
    [connectors, matrix] = await Promise.all([listConnectors(), getConnectorFeatureMatrix()]);
  } catch (err) {
    console.error("ACH availability check failed:", err);
    return {
      available: false,
      reason: UNAVAILABLE_REASON,
      detail: `Could not reach Hyperswitch to check connector configuration: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const active = connectors.filter((c) => c.disabled !== true && c.status !== "inactive");
  const achCapableIntegrations = new Set(
    matrix.filter(integrationSupportsAch).map((c) => c.name.toLowerCase()),
  );

  const enabledForAch = active.filter(supportsAch);
  const chargeable = enabledForAch.filter((c) =>
    achCapableIntegrations.has(c.connector_name.toLowerCase()),
  );

  if (chargeable.length > 0) {
    return { available: true, reason: null, detail: null };
  }

  // Enabled on a connector whose integration can't do ACH — the IR_19 case.
  // Worth calling out separately: from the dashboard this looks configured.
  if (enabledForAch.length > 0) {
    const names = enabledForAch.map((c) => c.connector_name).join(", ");
    return {
      available: false,
      reason: UNAVAILABLE_REASON,
      detail:
        `bank_debit/ach is enabled on ${names}, but ${
          enabledForAch.length === 1 ? "that connector's integration does" : "those connectors' integrations do"
        } not support it — a confirm would fail with IR_19. ` +
        `Connectors that do support ACH: ${[...achCapableIntegrations].sort().join(", ")}.`,
    };
  }

  const activeNames = active.map((c) => c.connector_name).join(", ") || "none";
  return {
    available: false,
    reason: UNAVAILABLE_REASON,
    detail:
      `No connector on this merchant has bank_debit/ach enabled, so a confirm would fail ` +
      `with IR_39. Active connectors: ${activeNames}. Hyperswitch connectors that support ` +
      `ACH: ${[...achCapableIntegrations].sort().join(", ")}.`,
  };
}
