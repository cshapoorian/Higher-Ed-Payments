# Endpoint Inventory

Every storefront API route that touches a payment, mapped to the exact
Hyperswitch endpoint behind it. See `project-description-architecture.md` for
the reasoning behind what's built vs. deferred — this file is the API-surface
checklist version of that.

All web → api calls go through `apps/web/src/api.ts`, which reads its target
host from `VITE_API_BASE_URL` — no endpoint URL is hardcoded in a component,
so pointing the SPA at a staging/production API is a config change, not a
code change.

Endpoint paths and payload fields last checked against Hyperswitch's public
docs on 2026-09-09.

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
immediately — both the endpoint shape and this status-transition behavior are
confirmed against Hyperswitch's own `payments/create` OpenAPI schema. The
quote step's fee goes in as `surcharge_details.surcharge_amount` — confirmed
as the exact, required field name on the `RequestSurchargeDetails` schema
(`apps/api/src/services/hyperswitch.ts`, `createPaymentIntent`). Response
gives `payment_id` + `client_secret`, persisted onto the `Order` row.

### Hosted-fields confirmation — `apps/web/src/lib/hyperswitch.ts`

→ `POST /payments/{payment_id}/confirm` (v1)

What the client SDK's `hyper.confirmPayment` calls once the hosted card
fields collect `payment_method_data` — attempts authorization with the
processor and lands on `succeeded` (automatic capture), `requires_capture`
(manual capture), or `failed` — this three-way outcome is stated verbatim in
Hyperswitch's "Payments - Confirm" reference. Called with the **publishable
key only**; `apps/api`'s secret key never reaches this file (verified — see
the comment above `loadHyper` in that file; this is a statement about our own
code, not something Hyperswitch's docs can confirm).

**Status: unverified live.** Confirmed against the spec, not yet run through
a real sandbox card.

### `GET /api/orders/:id`

→ `GET /payments/{payment_id}?force_sync=true&expand_captures=true&expand_attempts=true` (v1)

The client polls our route after confirming, since order state is only
supposed to advance on a verified webhook, not the client-side confirm
result. Our route now does the same reconciliation on the Hyperswitch side:
while the order is non-terminal, it force_syncs the connector directly
(`getPaymentStatus` in `services/hyperswitch.ts`) and applies whatever it
gets back through the same state-transition path the webhook uses
(`services/orderStatus.ts`).

`force_sync` is a documented, required query parameter on Hyperswitch's
retrieve-payment endpoint — without it, a status check can return
Hyperswitch's last-known cached value instead of a live check with the
connector, which would otherwise show up as the client polling forever on a
payment that already resolved but whose webhook was delayed or dropped.

`expand_captures` and `expand_attempts` are not confirmed against
Hyperswitch's own OpenAPI reference — they were only seen in a third-party
API aggregator's collection. They're plausible (the payment response schema
does carry `captures[]` and `attempts[]` arrays), but don't treat their
presence here as settled until a real sandbox call is made with them and the
arrays actually come back populated. If they turn out not to be real query
params, Hyperswitch will most likely just ignore the extra params rather than
error — but that itself hasn't been confirmed either.

### `POST /api/webhooks/hyperswitch`

Receiving side of Hyperswitch's outgoing webhook — not a path we call.
Hyperswitch POSTs here once a URL is registered on the dashboard under
Developer → Payment Settings.

Verification is HMAC over the **raw, unmodified** JSON body using the
dashboard's `payment_response_hash_key`: SHA-512 compared against
`x-webhook-signature-512`, or SHA-256 against `x-webhook-signature-256` as a
fallback (`verifyWebhookSignature` in `services/hyperswitch.ts`) — this exact
scheme, including the fallback header, is confirmed against Hyperswitch's
webhooks integration guide. The previous version of this route used a single
generic SHA-256 header, which didn't match Hyperswitch's actual scheme —
fixed (a claim about our own git history, not Hyperswitch-verifiable).

The thing to actually test against a live webhook delivery is that our
raw-body hashing matches Hyperswitch's exactly; any re-serialization of the
parsed JSON before hashing will produce a different digest and fail
verification even with the right key. That's why the route is mounted with
`express.raw()` ahead of the JSON body parser in `index.ts`.

**Status: unverified against a real webhook delivery.** The signature scheme
itself is confirmed correct against Hyperswitch's docs; what's untested is
our implementation of it against actual bytes Hyperswitch sends.

## Implemented

| Method & path | Purpose | Status |
|---|---|---|
| `GET /api/health` | Liveness check for hosting platforms | Working |
| `GET /api/me` | Returns the single seeded student/term (no auth yet) | Working, stand-in — see "Needed" below |
| `GET /api/course-sections` | Course catalog for the Courses step | Working |
| `POST /api/cart/price` | Prices selected sections into an itemized invoice | Working |
| `POST /api/orders/quote` | Fee-differentiated quote for a payment method | Working — own logic, no Hyperswitch call |
| `POST /api/orders/payment-intent` | Creates the Order + Hyperswitch Payment Intent, with surcharge_details | Spec-verified 2026-09-09 (endpoint, status transitions, and field name confirmed against Hyperswitch's OpenAPI); hosted-fields confirmation still unverified live |
| `GET /api/orders/:id` | Order status + receipt URL; force_syncs Hyperswitch while non-terminal | Working — `force_sync` param confirmed; `expand_captures`/`expand_attempts` unconfirmed against primary docs, recommend a live sandbox check |
| `POST /api/webhooks/hyperswitch` | Verifies (HMAC-SHA512/256) and applies Hyperswitch's terminal payment status | Signature scheme confirmed correct against Hyperswitch's docs; unverified against a real webhook delivery |

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

## Outstanding before this doc is fully "Working" end to end

1. Run one real sandbox card through the hosted-fields confirm flow and
   confirm a `payment_id` with `succeeded`/`requires_capture` comes back, plus
   one 3DS test card that forces `requires_customer_action`.
2. Trigger a real webhook delivery from the sandbox dashboard against the
   deployed `/api/webhooks/hyperswitch` URL, log the raw body and
   `x-webhook-signature-512` header pre-parse, and diff against the computed
   HMAC.
3. Confirm or drop `expand_captures`/`expand_attempts` on the `GET
   /api/orders/:id` → Hyperswitch call based on what an actual sandbox
   response contains.