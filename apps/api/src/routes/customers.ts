import { Router } from "express";
import type {
  CreateCustomerRequest,
  CreateCustomerResponse,
  GetPaymentMethodsResponse,
} from "@juspay-takehome/shared";
import { db } from "../db.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { listSavedPaymentMethods } from "../services/hyperswitch.js";
import { ensureHyperswitchCustomer } from "../services/customer.js";

export const customersRouter = Router();

// Provisions (idempotently) a Hyperswitch Customer for a student. The
// payment-intent route also calls this directly so a customer always exists
// before a charge — this route exists so it can be triggered explicitly
// (e.g. right after "login") instead of only lazily on first payment.
customersRouter.post(
  "/customers",
  asyncHandler(async (req, res) => {
    const { studentId } = req.body as CreateCustomerRequest;
    const hyperswitchCustomerId = await ensureHyperswitchCustomer(studentId);
    const response: CreateCustomerResponse = { hyperswitchCustomerId };
    res.json(response);
  }),
);

// Lists a student's saved cards so the UI can offer "Card ending 4242
// (saved)" only when a real saved method exists, instead of a static option.
customersRouter.get(
  "/payment-methods",
  asyncHandler(async (req, res) => {
    const studentId = req.query.studentId as string | undefined;
    if (!studentId) return res.status(400).json({ error: "studentId is required" });

    const student = await db.student.findUniqueOrThrow({ where: { id: studentId } });
    if (!student.hyperswitchCustomerId) {
      const response: GetPaymentMethodsResponse = { paymentMethods: [] };
      return res.json(response);
    }

    let saved: Awaited<ReturnType<typeof listSavedPaymentMethods>> = [];
    try {
      saved = await listSavedPaymentMethods(student.hyperswitchCustomerId);
    } catch (err) {
      // Hyperswitch unreachable or not yet configured — the "saved card"
      // method card just won't render rather than failing the whole page.
      console.error(`listSavedPaymentMethods failed for ${student.hyperswitchCustomerId}:`, err);
    }

    const response: GetPaymentMethodsResponse = {
      paymentMethods: saved
        .filter((m) => m.card)
        .map((m) => ({
          paymentMethodId: m.payment_method_id,
          brand: m.payment_method,
          last4: m.card!.last4_digits,
          expiryMonth: m.card!.expiry_month,
          expiryYear: m.card!.expiry_year,
        })),
    };
    res.json(response);
  }),
);
