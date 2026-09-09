import type { InvoiceLineItem } from "@juspay-takehome/shared";
import { db } from "../db.js";

// Server-authoritative pricing: the client never supplies an amount.
// See project-description-architecture.md §4 ("Server-authoritative Payment Intents")
// and §2 ("Itemized invoicing").
const LAB_FEE_CENTS = 15_000;
const ADMIN_FEE_CENTS = 10_000;
const FINANCIAL_AID_CREDIT_CENTS = 50_000;

export async function priceCart(courseSectionIds: string[]): Promise<{
  lineItems: InvoiceLineItem[];
  balanceDueCents: number;
}> {
  const sections = await db.courseSection.findMany({
    where: { id: { in: courseSectionIds } },
  });

  const lineItems: InvoiceLineItem[] = sections.map((s) => ({
    description: `${s.code} — ${s.title}`,
    amountCents: s.tuitionCents,
    kind: "tuition",
  }));

  if (sections.length > 0) {
    lineItems.push({ description: "Lab fee", amountCents: LAB_FEE_CENTS, kind: "fee" });
    lineItems.push({ description: "Admin fee", amountCents: ADMIN_FEE_CENTS, kind: "fee" });
    lineItems.push({
      description: "Financial aid credit",
      amountCents: -FINANCIAL_AID_CREDIT_CENTS,
      kind: "aid_credit",
    });
  }

  const balanceDueCents = lineItems.reduce((sum, item) => sum + item.amountCents, 0);

  return { lineItems, balanceDueCents };
}
