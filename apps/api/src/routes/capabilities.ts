import { Router } from "express";
import type { PaymentCapabilitiesResponse } from "@juspay-takehome/shared";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getAchAvailability } from "../services/achAvailability.js";

export const capabilitiesRouter = Router();

// Which payment methods this deployment's Hyperswitch account can actually
// charge, as opposed to which ones the storefront can draw. The payment step
// calls this once on load so ACH is offered or withheld based on the live
// account rather than a constant someone has to remember to edit — see
// services/achAvailability.ts for why both a connector check and a feature
// check are needed, and ENDPOINTS.md for the Hyperswitch endpoints behind it.
//
// Card is deliberately not reported here. It is verified working on this
// account, and a capabilities check that could withhold the only funded
// method would be a new way for the storefront to break.
capabilitiesRouter.get(
  "/payment-capabilities",
  asyncHandler(async (_req, res) => {
    const response: PaymentCapabilitiesResponse = { ach: await getAchAvailability() };
    res.json(response);
  }),
);
