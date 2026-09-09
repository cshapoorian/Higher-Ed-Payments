import type {
  CourseSection,
  CreatePaymentIntentRequest,
  CreatePaymentIntentResponse,
  GetOrderResponse,
  GetPaymentMethodsResponse,
  PriceCartRequest,
  PriceCartResponse,
  QuotePaymentRequest,
  QuotePaymentResponse,
  Student,
  Term,
} from "@juspay-takehome/shared";

// Every deploy target (local dev, staging, prod) points this at its own API
// origin via VITE_API_BASE_URL — nothing in this file may hardcode a host.
const BASE_URL = import.meta.env.VITE_API_BASE_URL;

// Some API responses (e.g. GetOrderResponse.receiptUrl) hand back a path
// relative to the API, not a browser-navigable URL — web and api are
// expected to be on different origins (Netlify + Render), so callers must
// resolve those paths against the API's own base URL, not the page's.
export function apiUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!BASE_URL) {
    throw new Error("VITE_API_BASE_URL is not set — see apps/web/.env.example");
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export function getCourseSections(): Promise<{ courseSections: CourseSection[] }> {
  return request("/course-sections");
}

export function getMe(): Promise<{ student: Student; term: Term }> {
  return request("/me");
}

export function priceCart(body: PriceCartRequest): Promise<PriceCartResponse> {
  return request("/cart/price", { method: "POST", body: JSON.stringify(body) });
}

export function createPaymentIntent(
  body: CreatePaymentIntentRequest,
): Promise<CreatePaymentIntentResponse> {
  return request("/orders/payment-intent", { method: "POST", body: JSON.stringify(body) });
}

export function quotePayment(body: QuotePaymentRequest): Promise<QuotePaymentResponse> {
  return request("/orders/quote", { method: "POST", body: JSON.stringify(body) });
}

export function getOrder(orderId: string): Promise<GetOrderResponse> {
  return request(`/orders/${orderId}`);
}

export function getPaymentMethods(studentId: string): Promise<GetPaymentMethodsResponse> {
  return request(`/payment-methods?studentId=${encodeURIComponent(studentId)}`);
}
