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

**Status: verified live for card, 2026-09-09.** A real payment intent
created through `POST /api/orders/payment-intent` was confirmed directly
against `sandbox.hyperswitch.io` with the publishable key + client_secret
(the same auth the browser SDK uses) — `4242 4242 4242 4242` returns
`succeeded` against the `fauxpay` test connector, `4000 0000 0000 0002`
returns `failed`. See `TEST_CREDENTIALS.md`. Still open: whether the actual
`Hyper()` browser widget (`apps/web/src/lib/hyperswitch.ts`) mounts and
fires its `change` event the way this file assumes — that needs a real
click-through, not just the REST call. **ACH cannot succeed on this
merchant account at all right now** — `GET /account/payment_methods` shows
no bank_debit-capable connector configured for this profile; see
`TEST_CREDENTIALS.md` for the exact error and the dashboard fix needed.

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
fallback (`verifyWebhookSignature` in `services/hyperswitch.ts`). The
previous version of this route used a single generic SHA-256 header, which
didn't match Hyperswitch's actual scheme — fixed. The thing to actually test
against a live webhook delivery is that our raw-body hashing matches
Hyperswitch's exactly; any re-serialization of the parsed JSON before hashing
will produce a different digest and fail verification even with the right
key. That's why the route is mounted with `express.raw()` ahead of the JSON
body parser in `index.ts`.

### `POST /api/customers` and `GET /api/payment-methods`

→ `POST /customers` and `GET /customers/{customer_id}/payment_methods` (v1)

`ensureHyperswitchCustomer` (`services/customer.ts`) idempotently provisions a
Hyperswitch Customer per student and is called automatically from
`/orders/payment-intent` — a customer must exist before a payment can be
tokenized for reuse (`card_saved`, and the mandate behind installment plans).
`POST /api/customers` exposes the same provisioning directly. `GET
/api/payment-methods?studentId=...` lists that customer's saved cards, so
"Card ending 4242 (saved)" in the UI only ever appears when a real saved
method exists — not a hardcoded option. Not to be confused with `GET
/account/payment_methods` above, which is client_secret-scoped for the SDK,
not customer-scoped for listing saved methods server-side.

**Known gap:** selecting the saved card still confirms through the same
hosted-fields flow as "New card" — it doesn't yet skip straight to a
one-click confirm against the stored `payment_method_id`. See the flagged
items below.

### `POST /api/installments/run-due`

→ `POST /payments` with `mandate_id` + `off_session: true` + `confirm: true` (v1) — the same `chargeMandate` call used for the plan's first-through-fourth charges.

Fires the next due, not-yet-charged installment for every plan with a saved
mandate. This project has no long-running process of its own to run a
scheduler, so this is designed to be hit periodically by external
infrastructure — see the deployment notes below. Protected by a shared
secret (`CRON_SECRET`) in an `x-cron-secret` header rather than a user
session, since the caller is infrastructure, not a browser.

Later installment charges get their own `Payment` row and their own
Hyperswitch `payment_id` — `services/orderStatus.ts` resolves an incoming
webhook by `Payment.hyperswitchPaymentId`, not `Order.paymentIntentId`, so a
later charge's own webhook reconciles correctly without touching the order's
overall status (which already flipped to `paid` when the first installment
succeeded).

## Implemented

| Method & path | Purpose | Status |
|---|---|---|
| `GET /api/health` | Liveness check for hosting platforms | Working |
| `GET /api/me` | Returns the single seeded student/term (no auth yet) | Working, stand-in — see "Needed" below |
| `GET /api/course-sections` | Course catalog for the Courses step | Working |
| `POST /api/cart/price` | Prices selected sections into an itemized invoice | Working |
| `POST /api/orders/quote` | Fee-differentiated quote for a payment method | Working — own logic, no Hyperswitch call |
| `POST /api/orders/payment-intent` | Creates the Order + Hyperswitch Payment Intent, with surcharge_details and a provisioned customer | Working — card confirm path verified live 2026-09-09; ACH blocked by merchant account config, see `TEST_CREDENTIALS.md` |
| `GET /api/orders/:id` | Order status + receipt URL; force_syncs Hyperswitch while non-terminal | Working |
| `GET /api/orders/:id/receipt` | Streams an itemized PDF receipt, rendered on demand | Working |
| `POST /api/customers` | Idempotently provisions a Hyperswitch Customer for a student | Working |
| `GET /api/payment-methods` | Lists a student's saved Hyperswitch payment methods | Working |
| `POST /api/installments/run-due` | Charges due installment mandates; meant to be cron-triggered | Working; needs an external scheduler wired up — see deployment notes |
| `POST /api/webhooks/hyperswitch` | Verifies (HMAC-SHA512/256) and applies Hyperswitch's terminal payment status | Signature scheme corrected; unverified against a real webhook delivery |

**Reliability fix:** every route above is now wrapped in `asyncHandler`
(`apps/api/src/lib/asyncHandler.ts`), with a final Express error-handling
middleware in `index.ts`. Before this, an async route handler that threw
(confirmed by actually triggering it: an invalid Hyperswitch key during
`/orders/payment-intent`) became an **unhandled promise rejection that
crashed the entire Node process** — not just that one request — taking the
API down for every user until something restarted it. This is fixed, not
flagged, since it's a correctness bug rather than a design tradeoff.

## Needed for a production system

Not built — each is a deliberate deferral (see architecture doc §3), called
out here as concrete endpoints someone would implement next, not left
implicit. Building these out was intentionally left for a follow-up rather
than done here alongside the deployment work — see the flagged items in the
project report for why.

- **`POST /api/auth/login` + session** — `GET /api/me` currently hands back
  the one seeded student with no auth. Real deployment needs student login
  (likely school SSO/SAML) before any of this is safe to expose publicly.
- **One-click saved-card confirm** — `GET /api/payment-methods` is real, but
  choosing "Card ending 4242 (saved)" still goes through the same
  hosted-fields confirmation as a new card rather than confirming directly
  against the stored `payment_method_id`. Needs a server route that confirms
  using the stored token instead of `hyper.elements`.
- **`POST /api/orders/:id/refund`** — needs a drop-date/withdrawal proration
  policy engine behind it before it's wired to Hyperswitch's Refunds API; the
  API call itself is the easy part.
- **`POST /api/payers/invite` + `GET /api/payers/:token`** — a scoped,
  login-less "pay this invoice" link for a parent/third-party payer,
  FERPA-consented and limited to one invoice.
- **`POST /api/funding/529`** + a reconciliation job — models a 529 credit as
  a pending funding request rather than an instant payment method, since no
  processor can pull 529 funds in real time.
- **Installment dunning** — `POST /api/installments/run-due` charges a due
  installment once; a failed charge is recorded as failed and never retried,
  and there's no registration-hold flag on repeated failure.
- **Real webhook registration** — once hosted, the deployed
  `POST /api/webhooks/hyperswitch` URL needs to be registered in the
  Hyperswitch dashboard under Developer → Payment Settings, with
  `HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY` set to that dashboard's signing key.
  A local-only tunnel (ngrok) is a stand-in for this during development.
- **Real PDF generation** in `apps/api/src/services/receipt.ts` — currently
  returns a placeholder URL; itemized PDF rendering (e.g. via `pdfkit`) is a
  TODO in that file.

## Outstanding before this doc is fully "Working" end to end

1. ~~Run one real sandbox card through the hosted-fields confirm flow and
   confirm a `payment_id` with `succeeded`/`requires_capture` comes back~~ —
   done 2026-09-09 via direct REST call, see `TEST_CREDENTIALS.md`. Still
   needed: the same thing through the actual browser `Hyper()` widget (to
   verify the `on("change")` assumption in `apps/web/src/lib/hyperswitch.ts`),
   plus one 3DS test card that forces `requires_customer_action`. Also: ACH
   has no eligible connector on this merchant account at all — needs a
   dashboard fix before it can be tested end to end.
2. Trigger a real webhook delivery from the sandbox dashboard against the
   deployed `/api/webhooks/hyperswitch` URL, log the raw body and
   `x-webhook-signature-512` header pre-parse, and diff against the computed
   HMAC.
3. Confirm or drop `expand_captures`/`expand_attempts` on the `GET
   /api/orders/:id` → Hyperswitch call based on what an actual sandbox
   response contains.