import { Router } from "express";
import type { Invoice, PriceCartRequest, PriceCartResponse } from "@juspay-takehome/shared";
import { db } from "../db.js";
import { priceCart } from "../services/pricing.js";

export const cartRouter = Router();

// The client sends selected course sections; the server returns the itemized
// invoice and balance due. These are the numbers later charged — the client
// never supplies an amount. See architecture §4 and §5 step 2.
cartRouter.post("/cart/price", async (req, res) => {
  const { studentId, termId, courseSectionIds } = req.body as PriceCartRequest;

  const { lineItems, balanceDueCents } = await priceCart(courseSectionIds);

  const record = await db.invoice.create({
    data: { studentId, termId, lineItems: JSON.stringify(lineItems), balanceDueCents },
  });

  const invoice: Invoice = {
    id: record.id,
    studentId: record.studentId,
    termId: record.termId,
    lineItems,
    balanceDueCents: record.balanceDueCents,
    createdAt: record.createdAt.toISOString(),
  };

  const response: PriceCartResponse = { invoice };
  res.json(response);
});
