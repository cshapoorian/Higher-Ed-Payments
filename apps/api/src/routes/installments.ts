import { Router } from "express";
import { db } from "../db.js";
import { env } from "../env.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { chargeMandate } from "../services/hyperswitch.js";
import { mapHyperswitchStatus } from "../services/orderStatus.js";

export const installmentsRouter = Router();

interface ScheduleEntry {
  sequence: number;
  dueDate: string;
  amountCents: number;
  paymentId: string | null;
}

// Fires the next merchant-initiated mandate charge for any installment plan
// with a due, not-yet-charged schedule entry. This project has no
// long-running process to run its own scheduler, so this is designed to be
// invoked periodically by something that does — a Render Cron Job hitting
// this URL, for example. See render.yaml and ENDPOINTS.md.
//
// Protected by a shared secret rather than a user session, since the caller
// is infrastructure, not a browser.
installmentsRouter.post(
  "/installments/run-due",
  asyncHandler(async (req, res) => {
  if (!env.cronSecret || req.header("x-cron-secret") !== env.cronSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const plans = await db.installmentPlan.findMany({ where: { mandateId: { not: null } } });
  const now = Date.now();
  const results: Array<{ orderId: string; sequence: number; status: string }> = [];

  for (const plan of plans) {
    const schedule = JSON.parse(plan.schedule) as ScheduleEntry[];
    const due = schedule.find((entry) => !entry.paymentId && new Date(entry.dueDate).getTime() <= now);
    if (!due || !plan.mandateId) continue;

    try {
      const charge = await chargeMandate(plan.mandateId, due.amountCents, "USD");
      const { payment: paymentStatus } = mapHyperswitchStatus(charge.status);

      await db.payment.create({
        data: {
          orderId: plan.orderId,
          hyperswitchPaymentId: charge.payment_id,
          method: "installment_plan",
          status: paymentStatus,
          amountCents: due.amountCents,
        },
      });

      const updatedSchedule = schedule.map((entry) =>
        entry.sequence === due.sequence ? { ...entry, paymentId: charge.payment_id } : entry,
      );
      await db.installmentPlan.update({
        where: { id: plan.id },
        data: { schedule: JSON.stringify(updatedSchedule) },
      });

      results.push({ orderId: plan.orderId, sequence: due.sequence, status: charge.status });
    } catch (err) {
      // Deliberately not retried here — installment dunning (retry policy,
      // registration holds on repeated failure) is a deferred feature. See
      // architecture §3 and ENDPOINTS.md.
      console.error(`installment charge failed for order ${plan.orderId} seq ${due.sequence}:`, err);
      results.push({ orderId: plan.orderId, sequence: due.sequence, status: "error" });
    }
  }

  res.json({ charged: results });
  }),
);
