# Sandbox test credentials

Values to punch into the Payment step's hosted fields when testing "New
card" against this project's Hyperswitch **sandbox** account. Nothing here
is a secret — these are the sandbox's own test-connector values, meaningless
outside it.

**Verified 2026-09-09** — not guessed from Hyperswitch's general docs. I ran
these directly against `https://sandbox.hyperswitch.io` using a real
payment intent created through this repo's own `POST
/api/orders/payment-intent` (so the amount, surcharge, and customer were
exactly what the real storefront flow produces), then confirmed it with the
publishable key the same way the browser SDK does. Raw responses are below
each result.

## New card → succeeds

| Field | Value |
|---|---|
| Card number | `4242 4242 4242 4242` |
| Expiry | any future date, e.g. `12/34` |
| CVC | any 3 digits, e.g. `123` |
| Cardholder name | anything, e.g. `Test Student` |

Confirmed live: `status: "succeeded"`, connector `fauxpay` (Hyperswitch's
own sandbox test connector — that's what's configured on this merchant
account, not Stripe/Adyen/etc.), `amount_received` matching the invoice
balance plus the 2.9% card surcharge.

### Card decline (for negative-path testing) → fails

| Field | Value |
|---|---|
| Card number | `4000 0000 0000 0002` |
| Expiry / CVC | same as above |

Confirmed live: `status: "failed"`, `error_code: "DC_08"`, `error_message:
"Payment declined: Card declined"`.

## Bank transfer (ACH) → currently cannot succeed on this account

This is the important finding: **no test bank account number will work
right now**, and it's not a credentials problem. `GET
/account/payment_methods` for a real ACH-eligible payment intent on this
merchant profile returns only `card` as an eligible payment method —
`bank_debit`/ACH isn't in the list at all. Attempting to confirm with
`payment_method: "bank_debit"` / `payment_method_type: "ach"` (any account
number) returns:

```
{"error":{"type":"invalid_request","message":"No eligible connector was found for the current payment method configuration","code":"IR_39"}}
```

None of the four connectors wired to this profile (`fauxpay`,
`paypal_test`, `stripe_test`, `pretendpay`) are configured for ACH bank
debit — only card. **To fix:** in the Hyperswitch Dashboard, under this
business profile's payment methods / connector settings, enable a bank-debit
connector for ACH (or turn on ACH for one of the existing test connectors,
if that's exposed there). Until that's done, selecting "Bank transfer
(ACH)" in the storefront will always fail at confirm — this is a dashboard
configuration gap, not a bug in `apps/web` or `apps/api`.

Routing `110000000` / account `000123456789` are the standard Stripe-style
ACH test values and are the first thing to try once a connector is actually
enabled for it — but treat them as unverified until then.

## Notes

- These fields are collected entirely inside Hyperswitch's hosted card
  element — never typed into our own API. Confirm stays disabled until the
  element reports the field as complete (see
  `apps/web/src/pages/PaymentPage.tsx`), so nothing is sent to Hyperswitch
  until you've actually filled the card in and clicked **Confirm & pay**.
- This verification used the REST confirm call directly (same auth —
  publishable key + client_secret — the browser SDK uses), not the actual
  `Hyper()` JS widget in a browser. So: the card number/decline behavior and
  the ACH configuration gap above are confirmed against the real account;
  whether `apps/web/src/lib/hyperswitch.ts`'s assumed `elements.create(...).on("change", ...)`
  event actually fires the way Stripe.js's does is still unverified — that
  needs an actual click-through in the browser.
- "Card ending 4242 (saved)" in the UI reflects a real saved Hyperswitch
  payment method for the seeded student, created the first time the New
  card success case above is confirmed through the real storefront UI — it
  isn't a hardcoded row.
