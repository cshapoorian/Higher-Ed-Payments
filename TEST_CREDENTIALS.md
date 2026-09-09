# Sandbox test credentials

Values to punch into the Payment step against this project's Hyperswitch
**sandbox** account. Nothing here is a secret — these are the sandbox's own
test-connector values, meaningless outside it. Verified live 2026-09-09.

## Card

### Happy path — succeeds

| Field | Value |
|---|---|
| Card number | `4242 4242 4242 4242` |
| Expiry | any future date, e.g. `12/34` |
| CVC | any 3 digits, e.g. `123` |
| Cardholder name | anything |

Result: `status: "succeeded"`, storefront order → `paid`, receipt generated.

### Error path — declined

| Field | Value |
|---|---|
| Card number | `4000 0000 0000 0002` |
| Expiry / CVC | same as above |

Result: `status: "failed"`, `error_code: "DC_08"` ("Payment declined: Card
declined"), storefront order → `failed`, no receipt.

## Bank transfer (ACH)

### Error path — unavailable account

| Field | Value |
|---|---|
| Account holder name | anything |
| Routing number | `110000000` |
| Account number | `000123456789` |

Result: Hyperswitch returns `IR_39` ("No eligible connector was found for the
current payment method configuration"), the storefront shows "Bank transfers
aren't enabled on this account, so this payment can't be taken. Pay by card
instead," and the order is left at `payment_pending` (not marked failed).

### Happy path — not set up

No connector on this merchant (`fauxpay`, `paypal_test`, `stripe_test`,
`pretendpay`) implements `bank_debit` — they're Hyperswitch dummy connectors,
card-only. Enabling ACH on them 200s but every confirm then fails with
`IR_19`. A working ACH success path needs a real connector added to the
profile (Adyen, Stripe, GoCardless, Dwolla, Stax, Payload, or Wells Fargo)
with that processor's own sandbox credentials — not a dashboard toggle on the
existing connectors. Once one is added, `110000000` / `000123456789` above
are the standard test values to try, and no code change is needed: ACH
availability is read live from the account (`GET /api/payment-capabilities`).

## Not set up

- **Installment payments 2–4.** The intent is created for the full balance,
  not the first installment, and no mandate is stored. Use "New card" unless
  testing the plan's pricing display.
- **Saved card.** Card payments don't set `setup_future_usage`, so nothing is
  tokenized and "Card ending 4242 (saved)" never appears.
