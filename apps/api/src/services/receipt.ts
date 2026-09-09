import PDFDocument from "pdfkit";
import type { Response } from "express";
import type { Order } from "@juspay-takehome/shared";
import { db } from "../db.js";

interface InvoiceLineItemRow {
  description: string;
  amountCents: number;
  kind: string;
}

function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/**
 * Called once an order transitions to Paid (services/orderStatus.ts) to
 * record that a receipt exists. Returns a path, not a file — the PDF itself
 * is rendered on demand by streamReceiptPdf below rather than written to
 * disk, since this API may run on ephemeral storage once hosted (see
 * ENDPOINTS.md). apps/web resolves this against its own API base URL rather
 * than treating it as a browser-navigable URL directly, since web and api
 * are expected to be on different origins (Netlify + Render).
 */
export async function generateReceipt(order: Order): Promise<{ pdfUrl: string }> {
  return { pdfUrl: `/orders/${order.id}/receipt` };
}

/**
 * Renders an itemized PDF receipt and streams it directly into the HTTP
 * response — nothing is written to disk. Returns false (caller should 404)
 * if the order has no receipt on record yet.
 */
export async function streamReceiptPdf(orderId: string, res: Response): Promise<boolean> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      invoice: { include: { student: true, term: true } },
      payments: true,
      receipt: true,
    },
  });
  if (!order || !order.receipt) return false;

  const lineItems = JSON.parse(order.invoice.lineItems) as InvoiceLineItemRow[];
  const payment =
    order.payments.find((p) => p.hyperswitchPaymentId === order.paymentIntentId) ?? order.payments[0];

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="receipt-${order.id}.pdf"`);

  const doc = new PDFDocument({ size: "LETTER", margin: 54 });
  doc.pipe(res);

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const row = (label: string, value: string) => {
    const y = doc.y;
    doc.font("Helvetica").fontSize(10).fillColor("#000").text(label, doc.page.margins.left, y);
    doc.text(value, doc.page.margins.left, y, { width: contentWidth, align: "right" });
    doc.moveDown(0.6);
  };

  doc.font("Helvetica-Bold").fontSize(18).text("Meridian University");
  doc.font("Helvetica").fontSize(11).fillColor("#555").text("Student Financial Services — Payment Receipt");
  doc.moveDown();

  doc.fillColor("#000").fontSize(10);
  doc.text(`Receipt issued: ${order.receipt.issuedAt.toLocaleDateString("en-US")}`);
  doc.text(`Order: ${order.id}`);
  doc.text(`Student: ${order.invoice.student.name} (${order.invoice.student.email})`);
  doc.text(`Term: ${order.invoice.term.label}`);
  doc.moveDown();

  doc.font("Helvetica-Bold").fontSize(12).text("Invoice");
  doc.moveDown(0.3);
  for (const item of lineItems) {
    row(item.description, formatUsd(item.amountCents));
  }
  doc.moveDown(0.2);
  doc.font("Helvetica-Bold");
  row("Balance due", formatUsd(order.invoice.balanceDueCents));
  doc.font("Helvetica");
  doc.moveDown();

  if (payment) {
    doc.font("Helvetica-Bold").fontSize(12).text("Payment");
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(10);
    row("Method", payment.method);
    row("Amount charged", formatUsd(payment.amountCents));
    row("Status", payment.status);
  }

  doc.moveDown();
  doc
    .fontSize(8)
    .fillColor("#888")
    .text("This receipt is generated for recordkeeping. Retain for tax and financial aid purposes.");

  doc.end();
  return true;
}
