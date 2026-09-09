// Domain types shared between apps/api and apps/web.
// Mirrors the data model in project-description-architecture.md §5.

export type OrderStatus =
  | "draft"
  | "reviewed"
  | "payment_pending"
  | "processing"
  | "paid"
  | "failed";

export type PaymentMethodType = "card_new" | "card_saved" | "ach" | "installment_plan";

export type PaymentStatus = "requires_confirmation" | "processing" | "succeeded" | "failed";

export interface Student {
  id: string;
  name: string;
  email: string;
  hyperswitchCustomerId: string | null;
}

export interface Term {
  id: string;
  label: string; // e.g. "Fall 2026"
  dueDate: string; // ISO date
}

export interface CourseSection {
  id: string;
  code: string; // e.g. "CS 101"
  title: string;
  credits: number;
  tuitionCents: number;
}

export interface InvoiceLineItem {
  description: string;
  amountCents: number; // negative for credits (e.g. financial aid)
  kind: "tuition" | "fee" | "aid_credit";
}

export interface Invoice {
  id: string;
  studentId: string;
  termId: string;
  lineItems: InvoiceLineItem[];
  balanceDueCents: number; // server-computed, authoritative
  createdAt: string;
}

export interface Order {
  id: string;
  invoiceId: string;
  status: OrderStatus;
  paymentIntentId: string | null; // Hyperswitch payment_id
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  orderId: string;
  hyperswitchPaymentId: string;
  method: PaymentMethodType;
  status: PaymentStatus;
  amountCents: number;
  createdAt: string;
}

export interface InstallmentPlan {
  id: string;
  orderId: string;
  mandateId: string; // Hyperswitch mandate_id backing MIT charges
  installmentCount: number;
  intervalDays: number;
  schedule: InstallmentScheduleEntry[];
}

export interface InstallmentScheduleEntry {
  sequence: number;
  dueDate: string; // ISO date
  amountCents: number;
  paymentId: string | null; // populated once charged
}

export interface Receipt {
  id: string;
  orderId: string;
  pdfUrl: string;
  issuedAt: string;
}

// --- API request/response contracts between apps/web and apps/api ---

export interface PriceCartRequest {
  studentId: string;
  termId: string;
  courseSectionIds: string[];
}

export interface PriceCartResponse {
  invoice: Invoice;
}

export interface CreatePaymentIntentRequest {
  invoiceId: string;
  method: PaymentMethodType;
}

export interface CreatePaymentIntentResponse {
  order: Order;
  clientSecret: string;
  publishableKey: string;
  quote: PaymentMethodQuote;
}

// --- Fee-differentiated payment methods (architecture §2, §4) ---
// ACH is free; card and card-financed installments carry a surcharge. The
// server computes this — the client only ever renders what quotePayment
// returns, never derives or overrides a total itself.

export interface PaymentMethodQuote {
  method: PaymentMethodType;
  balanceDueCents: number;
  feeCents: number;
  feeLabel: string;
  totalCents: number; // balanceDueCents + feeCents — what's actually charged
  installmentSchedule?: InstallmentScheduleEntry[]; // present only for installment_plan
}

export interface QuotePaymentRequest {
  invoiceId: string;
  method: PaymentMethodType;
}

export interface QuotePaymentResponse {
  quote: PaymentMethodQuote;
}
