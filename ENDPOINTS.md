# Endpoint Inventory

What exists today under `apps/api/src/routes/`, and what's still needed before
this system is production-ready. See `project-description-architecture.md`
for the reasoning behind what's built vs. deferred — this file is just the
API-surface checklist version of that.

All web → api calls go through `apps/web/src/api.ts`, which reads its target
host from `VITE_API_BASE_URL` — no endpoint URL is hardcoded in a component,
so pointing the SPA at a staging/production API is a config change, not a
code change.

## Implemented

These are wired end-to-end (route → service → SQLite via Prisma) and called
by the SPA today.

| Method & path | Purpose | Status |
|---|---|---|
| `GET /api/health` | Liveness check for hosting platforms | Working |
| `GET /api/me` | Returns the single seeded student/term (no auth yet) | Working, stand-in — see "Needed" below |
| `GET /api/course-sections` | Course catalog for the Courses step | Working |
| `POST /api/cart/price` | Prices selected sections into an itemized invoice | Working |
| `POST /api/orders/quote` | Fee-differentiated quote for a payment method (ACH free, card surcharged) | Working |
| `POST /api/orders/payment-intent` | Creates the Order + Hyperswitch Payment Intent | Logic verified 2026-09-09; unverified live: `apps/web/src/lib/hyperswitch.ts` hosted-fields confirmation |
| `GET /api/orders/:id` | Order status + receipt URL, polled by the client after confirming a payment | Working |
| `POST /api/webhooks/hyperswitch` | Verifies and applies Hyperswitch's terminal payment status | Logic complete; signature verification unverified against a real webhook delivery |

## Needed for a production system

Not built — each is a deliberate deferral (see architecture doc §3), called
out here as concrete endpoints someone would implement next, not left
implicit.

- **`POST /api/auth/login` + session** — `GET /api/me` currently hands back
  the one seeded student with no auth. Real deployment needs student login
  (likely school SSO/SAML) before any of this is safe to expose publicly.
- **`POST /api/customers`** — provision a Hyperswitch Customer for a student
  on first payment so cards can be saved and reused every term (the
  `createCustomer` Hyperswitch client call already exists in
  `apps/api/src/services/hyperswitch.ts` but no route calls it yet).
- **`GET /api/payment-methods`** — list a student's saved Hyperswitch payment
  methods, so "Card ending 4242 (saved)" in the UI reflects real saved cards
  instead of a static option.
- **`POST /api/orders/:id/installments/charge`** (or a scheduled job hitting
  the same logic) — fires the next merchant-initiated mandate charge in an
  installment plan. `chargeMandate` exists in the Hyperswitch service; nothing
  invokes it on a schedule yet.
- **`POST /api/orders/:id/refund`** — needs a drop-date/withdrawal proration
  policy engine behind it before it's wired to Hyperswitch's Refunds API; the
  API call itself is the easy part.
- **`POST /api/payers/invite` + `GET /api/payers/:token`** — a scoped,
  login-less "pay this invoice" link for a parent/third-party payer,
  FERPA-consented and limited to one invoice.
- **`POST /api/funding/529`** + a reconciliation job — models a 529 credit as
  a pending funding request rather than an instant payment method, since no
  processor can pull 529 funds in real time.
- **Real webhook registration** — once hosted, the deployed
  `POST /api/webhooks/hyperswitch` URL needs to be registered in the
  Hyperswitch dashboard; a local-only tunnel (ngrok) is a stand-in for this
  during development.
- **Real PDF generation** in `apps/api/src/services/receipt.ts` — currently
  returns a placeholder URL; itemized PDF rendering (e.g. via `pdfkit`) is a
  TODO in that file.
