# Endpoint Inventory

Every storefront API route that touches a payment, mapped to the exact
Hyperswitch endpoint behind it. See `project-description-architecture.md` for
the reasoning behind what's built vs. deferred — this file is the API-surface
checklist version of that.

All web → api calls go through `apps/web/src/api.ts`, which reads its target
host from `VITE_API_BASE_URL` — no endpoint URL is hardcoded in a component,
so pointing the SPA at a staging/production API is a config change, not a
code change.

## Payment flow, endpoint by endpoint

### `POST /api/orders/quote`

No Hyperswitch call — `apps/api/src/services/feeQuote.ts` is our own pricing
logic (ACH free, card/installment surcharged). Its output (`feeCents`) is
what the next endpoint hands to Hyperswitch as `surcharge_details`.

Optionally, if this pricing rule ever needs to be owned by Hyperswitch
instead of us — e.g. connector-specific surcharge rates — `GET
/account/payment_methods` is the endpoint the client SDK calls to list
applicable payment methods for a payment, authenticated via the
`client_secret` + publishable key. Combined with Surcharge Decision Manager
rules configured in the Control Center, that's how Hyperswitch computes the
differential instead of us hardcoding it. Not used here; noted for later.

### `POST /api/orders/payment-intent`

→ `POST /payments` (v1, sandbox `https://sandbox.hyperswitch.io/payments`)

Creates the Payment Intent server-side with the secret key, `confirm: false`
so it comes back `requires_payment_method` instead of attempting to charge
immediately. The quote step's fee goes in as `surcharge_details.surcharge_amount`
(`apps/api/src/services/hyperswitch.ts`, `createPaymentIntent`). Response
gives `payment_id` + `client_secret`, persisted onto the `Order` row.

### Hosted-fields confirmation — `apps/web/src/lib/hyperswitch.ts`

→ `POST /payments/{payment_id}/confirm` (v1)

What the client SDK's `hyper.confirmPayment` calls once the hosted card
fields collect `payment_method_data` — attempts authorization with the
processor and lands on `succeeded` (automatic capture), `requires_capture`
(manual capture), or `failed`. Called with the **publishable key only**;
`apps/api`'s secret key never reaches this file (verified — see the comment
above `loadHyper` in that file).

### `GET /api/orders/:id`

→ `GET /payments/{payment_id}?force_sync=true&expand_captures=true&expand_attempts=true` (v1)

The client polls our route after confirming, since order state is only
supposed to advance on a verified webhook, not the client-side confirm
result. Our route now does the same reconciliation on the Hyperswitch side:
while the order is non-terminal, it force_syncs the connector directly
(`getPaymentStatus` in `services/hyperswitch.ts`) and applies whatever it
gets back through the same state-transition path the webhook uses
(`services/orderStatus.ts`). `force_sync=true` matters specifically here —
without it, a status check can return Hyperswitch's last-known cached value
instead of a live check with the connector, which would otherwise show up as
the client polling forever on a payment that already resolved but whose
webhook was delayed or dropped.

### `POST /api/webhooks/hyperswitch`

Receiving side of Hyperswitch's outgoing webhook — not a path we call.
Hyperswitch POSTs here once a URL is registered on the dashboard under
Developer → Payment Settings.

Verification is HMAC over the **raw, unmodified** JSON body using the
dashboard's `payment_response_hash_key`: SHA-512 compared against
`x-webhook-signature-512`, or SHA-256 against `x-webhook-signature-256` as a
fallback (`verifyWebhookSignature` in `services/hyperswitch.ts`). The
previous version of this route used a single generic SHA-256 header, which
didn't match Hyperswitch's actual scheme — fixed. The thing to actually test
against a live webhook delivery is that our raw-body hashing matches
Hyperswitch's exactly; any re-serialization of the parsed JSON before hashing
will produce a different digest and fail verification even with the right
key. That's why the route is mounted with `express.raw()` ahead of the JSON
body parser in `index.ts`.

## Implemented

| Method & path | Purpose | Status |
|---|---|---|
| `GET /api/health` | Liveness check for hosting platforms | Working |
| `GET /api/me` | Returns the single seeded student/term (no auth yet) | Working, stand-in — see "Needed" below |
| `GET /api/course-sections` | Course catalog for the Courses step | Working |
| `POST /api/cart/price` | Prices selected sections into an itemized invoice | Working |
| `POST /api/orders/quote` | Fee-differentiated quote for a payment method | Working — own logic, no Hyperswitch call |
| `POST /api/orders/payment-intent` | Creates the Order + Hyperswitch Payment Intent, with surcharge_details | Logic verified 2026-09-09; hosted-fields confirmation still unverified live |
| `GET /api/orders/:id` | Order status + receipt URL; force_syncs Hyperswitch while non-terminal | Working |
| `POST /api/webhooks/hyperswitch` | Verifies (HMAC-SHA512/256) and applies Hyperswitch's terminal payment status | Signature scheme corrected; unverified against a real webhook delivery |

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
- **`GET /api/payment-methods`** (backed by Hyperswitch's `GET
  /account/payment_methods`) — list a student's saved Hyperswitch payment
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
  Hyperswitch dashboard under Developer → Payment Settings, with
  `HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY` set to that dashboard's signing key.
  A local-only tunnel (ngrok) is a stand-in for this during development.
- **Real PDF generation** in `apps/api/src/services/receipt.ts` — currently
  returns a placeholder URL; itemized PDF rendering (e.g. via `pdfkit`) is a
  TODO in that file.
