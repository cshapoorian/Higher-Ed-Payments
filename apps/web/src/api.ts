import type {
  CourseSection,
  CreatePaymentIntentRequest,
  CreatePaymentIntentResponse,
  PriceCartRequest,
  PriceCartResponse,
  Student,
  Term,
} from "@juspay-takehome/shared";

const BASE_URL = import.meta.env.VITE_API_BASE_URL;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
