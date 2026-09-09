import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { verifyWebhookSignature } from "../services/hyperswitch.js";
import { applyHyperswitchStatus } from "../services/orderStatus.js";

export const webhooksRouter = Router();

// Order state only advances here, on a verified server-to-server webhook —
// never on client redirect. A closed tab or dropped connection can't fake a
// completed payment. See architecture §3 and §5 step 6.
// NOTE: mounted with express.raw() in index.ts so req.body is the raw Buffer
// needed for signature verification — it must be hashed byte-for-byte as
// received, not re-serialized from a parsed object.
webhooksRouter.post(
  "/hyperswitch",
  asyncHandler(async (req, res) => {
  const rawBody = req.body as Buffer;
  const verified = verifyWebhookSignature(rawBody, {
    signature512: req.header("x-webhook-signature-512"),
    signature256: req.header("x-webhook-signature-256"),
  });
  if (!verified) {
    return res.status(401).json({ error: "invalid signature" });
  }

  const event = JSON.parse(rawBody.toString("utf8")) as {
    content: { object: { payment_id: string; status: string; mandate_id?: string } };
  };
  const { payment_id: paymentIntentId, status, mandate_id: mandateId } = event.content.object;

  const order = await applyHyperswitchStatus(paymentIntentId, status, mandateId);
  if (!order) return res.status(404).json({ error: "order not found" });

  res.json({ received: true });
  }),
);
