# Fake sandbox credentials

Everything below is a **fake, dummy value** meaningless outside this
project's Hyperswitch **sandbox** account — not a real card, bank account, or
secret. Use them on the [live demo](https://higher-ed-payments-demo.netlify.app/)
or a local run to pay an invoice. Verified live 2026-09-09.

## Card

### Happy path — succeeds

| Field | Value |
|---|---|
| Card number | `4242 4242 4242 4242` |
| Expiry | any future date, e.g. `12/34` |
| CVC | any 3 digits, e.g. `123` |
| Cardholder name | anything |

Result: `status: "succeeded"`, order → `paid`, receipt generated.

### Error path — declined

| Field | Value |
|---|---|
| Card number | `4000 0000 0000 0002` |
| Expiry / CVC | same as above |

Result: `status: "failed"`, `error_code: "DC_08"` ("Payment declined: Card
declined"), order → `failed`, no receipt.

## Bank transfer (ACH)

### Error path — unavailable account

| Field | Value |
|---|---|
| Account holder name | anything |
| Routing number | `110000000` |
| Account number | `000123456789` |

Result: Hyperswitch returns `IR_39` ("No eligible connector was found for the
current payment method configuration"). The storefront shows "Bank transfers
aren't enabled on this account, so this payment can't be taken. Pay by card
instead," and the order stays at `payment_pending` (not marked failed).

### Happy path — not available on this sandbox account

None of this merchant's connectors (`fauxpay`, `paypal_test`, `stripe_test`,
`pretendpay`) support `bank_debit` — they're Hyperswitch dummy connectors,
card-only. A working ACH success path needs a real connector on the profile
(Adyen, Stripe, GoCardless, Dwolla, Stax, Payload, or Wells Fargo) with that
processor's own sandbox credentials. Once one is added, no code change is
needed — ACH availability is read live from the account via
`GET /api/payment-capabilities`.

## Installment plan

The first charge now charges only the first installment and requests a
mandate (`mandate_data` on the intent). Confirm with the card values above to
see the plan's first payment go through. What still needs a person or a job:
payments 2–4 are only collected when something calls
`POST /api/installments/run-due` with header `x-cron-secret: <CRON_SECRET>` —
nothing schedules that call automatically yet, so the plan will sit
uncollected past the first charge unless you trigger it yourself.

## Not set up

- **Saved card reuse.** Card payments don't set `setup_future_usage` outside
  the installment flow, so "Card ending 4242 (saved)" only appears once a
  mandate-backed card has actually been used once.
