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
if that's exposed there). This is a dashboard configuration gap, not a bug in
`apps/web` or `apps/api`. Until it's fixed, the storefront disables the ACH
method outright — the Pay button reads "ACH unavailable on this account" and
a notice explains why — rather than letting a student fill in a form that
cannot succeed. Re-enabling is a one-line change in
`apps/web/src/pages/PaymentPage.tsx` (`achUnavailable`).

Routing `110000000` / account `000123456789` are the standard Stripe-style
ACH test values and are the first thing to try once a connector is actually
enabled for it — but treat them as unverified until then.

## Notes

- Card number, expiry and CVC are collected entirely inside Hyperswitch's
  hosted card element — never typed into our own API. **Pay is not gated on
  card completeness**, because the SDK gives us no way to observe it (next
  note); it gates on the hosted iframe having painted and on our own billing
  fields being filled. An incomplete card is caught by `confirmPayment`
  rejecting, and that message is surfaced to the student.
- **The browser widget is now verified live too** (2026-09-09, against
  `https://beta.hyperswitch.io/v1/HyperLoader.js` — note the SDK is served
  from a different host than the REST API, which 404s on that path).
  Confirmed: the global really is `window.Hyper`, and
  `elements.create("card")` mounts one iframe holding card number, MM/YY and
  CVC, whose fields accept input. Also confirmed, and the reason the
  Pay-button gating changed: the element emits **`ready`, `focus` and `blur`
  only** — there is no Stripe-style `change` event carrying `{ complete }`.
  Gating Pay on one left the button disabled forever.
- Routing and account numbers for ACH are ordinary labelled inputs, not a
  hosted element. That's deliberate: bank data sits outside PCI's
  cardholder-data scope, and it still goes from the browser to Hyperswitch
  rather than through our API. Mounting Hyperswitch's unified `payment`
  element there was tried and reverted — on this account it renders a *card*
  form, which under a "Link your bank" heading would invite someone to type
  card data into what they believe is a bank transfer.
- **"Card ending 4242 (saved)" will not appear yet.** The option reads from a
  real Hyperswitch customer lookup rather than a hardcoded row, so it only
  renders when a saved method actually exists — but card payments don't set
  `setup_future_usage`, so nothing is tokenized through the ordinary flow and
  the lookup comes back empty. See architecture doc §3, "Saved-card reuse".
- **The installment plan charges the full balance today.** The intent is
  created for the whole amount rather than the first installment, and no
  mandate is stored, so payments 2–4 are never taken. The payment page says
  so on selection. Use "New card" unless you're specifically exercising the
  plan's pricing.
