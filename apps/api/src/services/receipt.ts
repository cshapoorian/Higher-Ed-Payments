import type { Order } from "@juspay-takehome/shared";

// TODO: generate a real itemized PDF (e.g. pdfkit) once Order → Payment →
// Invoice line items are wired end-to-end. See architecture §3 ("Built").
export async function generateReceipt(order: Order): Promise<{ pdfUrl: string }> {
  return { pdfUrl: `/receipts/${order.id}.pdf` };
}
