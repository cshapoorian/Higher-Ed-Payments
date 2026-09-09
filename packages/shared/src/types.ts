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
  // Hyperswitch's REST origin, handed to the browser so the ACH confirm can
  // be POSTed straight to Hyperswitch with the publishable key. It comes
  // from the API's own env rather than a second VITE_ var so the base URL
  // and the publishable key above can never drift apart between the two
  // apps. Card still confirms through the hosted-fields SDK, which takes
  // this origin from the loader script instead.
  hyperswitchBaseUrl: string;
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

// --- Order status polling (architecture §3, §5 step 6) ---
// Order state only advances on a verified Hyperswitch webhook, never on
// client redirect — so the client polls this after confirming a payment to
// learn the real terminal status instead of assuming success.

export interface GetOrderResponse {
  order: Order;
  receiptUrl: string | null;
}

// --- Payment-method capabilities (see services/achAvailability.ts) ---
// Whether a method can actually be *charged* on the merchant profile this
// API is pointed at, as opposed to merely being renderable. ACH is the one
// method whose answer is "no" on the current sandbox account, and that is a
// property of the account, not of this code — so the storefront asks rather
// than hardcoding a flag it would have to remember to flip.

export interface PaymentMethodAvailability {
  available: boolean;
  /** Student-facing sentence. Null when available. */
  reason: string | null;
  /** Operator-facing detail: what is wired up vs. what would need to be. */
  detail: string | null;
}

export interface PaymentCapabilitiesResponse {
  ach: PaymentMethodAvailability;
}

// --- Hyperswitch customer + saved payment methods (architecture §4) ---
// One tokenized Hyperswitch Customer per student, reused every term, so a
// saved card can be charged one-click without re-entering card data.

export interface CreateCustomerRequest {
  studentId: string;
}

export interface CreateCustomerResponse {
  hyperswitchCustomerId: string;
}

export interface SavedPaymentMethod {
  paymentMethodId: string;
  brand: string; // e.g. "card"
  last4: string;
  expiryMonth: string;
  expiryYear: string;
}

export interface GetPaymentMethodsResponse {
  paymentMethods: SavedPaymentMethod[];
}
