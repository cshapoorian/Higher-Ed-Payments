# Sandbox test credentials

Values to punch into the Payment step when testing against this project's
Hyperswitch **sandbox** account. Nothing here is a secret — these are the
sandbox's own test-connector values, meaningless outside it.

**Verified 2026-09-09** — not guessed from Hyperswitch's general docs. Every
result below was produced by driving this repo's own API (`POST
/api/cart/price` → `POST /api/orders/payment-intent`) so the amount,
surcharge and customer were exactly what the real storefront flow produces,
then confirming with the publishable key the same way the browser does. Raw
responses are quoted under each result.

## Summary — what works and what doesn't

| Path | Works? | Verified how |
|---|---|---|
| Card → succeeds | ✅ Yes | Live confirm → `succeeded`, order `paid`, receipt generated |
| Card → declined | ✅ Yes | Live confirm → `failed` / `DC_08`, order `failed`, no receipt |
| Card hosted fields in the browser | ✅ Yes | SDK loaded live; iframe mounts and accepts input |
| ACH → invalid routing number | ✅ Yes | Rejected in-browser by ABA check digit, before any network call |
| ACH → unavailable-account path | ✅ Yes | Live confirm → `IR_39`, surfaced to the student, order untouched |
| **ACH → succeeds** | ❌ **No — blocked on the account, not the code** | No connector on this merchant implements `bank_debit`; see below |
| Installment payments 2–4 | ❌ No | Knowingly unfinished — see `ENDPOINTS.md` |

## Card

### New card → succeeds

| Field | Value |
|---|---|
| Card number | `4242 4242 4242 4242` |
| Expiry | any future date, e.g. `12/34` |
| CVC | any 3 digits, e.g. `123` |
| Cardholder name | anything, e.g. `Test Student` |
| Billing address | anything; all fields except line 2 are required by the form |

Confirmed live end to end: Hyperswitch returns `status: "succeeded"` on
connector `fauxpay` (Hyperswitch's own sandbox test connector — that's what
is configured on this merchant account, not a real Stripe/Adyen), the
storefront order flips to `paid`, and the itemized PDF receipt is generated.
`amount_received` matches the invoice balance plus the 2.9% card surcharge
(e.g. $3,950.00 balance → $4,064.55 charged).

### Card decline (negative path) → fails

| Field | Value |
|---|---|
| Card number | `4000 0000 0000 0002` |
| Expiry / CVC | same as above |

Confirmed live: `status: "failed"`, `error_code: "DC_08"`, `error_message:
"Payment declined: Card declined"`. The storefront order goes to `failed`, no
receipt is issued, and the decline text is shown to the student rather than a
generic "payment failed".

## Bank transfer (ACH)

Two of the three ACH paths are finished and verified. The success path is
written, exercised as far as the account permits, and **cannot be completed
on this sandbox account** — for a reason that is worth reading, because it is
not the reason it first appears to be.

### ACH → invalid routing number (bad path) → rejected in the browser

| Field | Value | Result |
|---|---|---|
| Routing number | `110000001` | ❌ "That routing number isn't valid…" |
| Routing number | `123456789` | ❌ rejected |
| Routing number | `110000000` | ✅ accepted (Stripe's ACH test routing number) |
| Routing number | `021000021` | ✅ accepted (real: JPMorgan Chase) |
| Routing number | `026009593` | ✅ accepted (real: Bank of America) |
| Routing number | `121000248` | ✅ accepted (real: Wells Fargo) |
| Account number | any 4–17 digits, e.g. `000123456789` | ✅ accepted |
| Account number | 1–3 digits | ❌ "Account numbers are 4–17 digits." |

US ABA routing numbers carry a check digit in the ninth position, so a
mistyped one is provably wrong without asking anyone. `isValidRoutingNumber`
in `apps/web/src/lib/hyperswitch.ts` verifies it and the Pay button stays
disabled until it passes — no network call, no days-later bank rejection.
Verified against the five real routing numbers above plus wrong-length,
non-numeric and off-by-one-check-digit inputs.

Account numbers have no equivalent check digit; length is genuinely all that
can be asserted client-side, which is why only the routing number gets a real
validator.

### ACH → unavailable account (bad path) → explained, not silently broken

With valid details entered, the confirm goes browser → Hyperswitch and comes
back:

```
{"error":{"type":"invalid_request","message":"No eligible connector was found for the current payment method configuration","code":"IR_39"}}
```

The storefront translates `IR_39` (and its sibling `IR_19`) into "Bank
transfers aren't enabled on this account, so this payment can't be taken. Pay
by card instead," because those two codes describe the *merchant account*, not
anything the student did. Verified live that the order is left at
`payment_pending` — a rejected confirm must not mark the order failed.

In practice a student never reaches this error, because the payment step asks
`GET /api/payment-capabilities` on load and disables ACH up front. It is the
backstop for the race where a connector is removed mid-session.

### ACH → succeeds: blocked, and here is the actual reason

**No test bank account number will work on this account, and it is not a
credentials problem.** The earlier version of this file blamed a missing
dashboard toggle. That was wrong, and the difference matters:

1. ACH *was* enabled on all four connectors via `POST
   /account/{merchant_id}/connectors` — each returned **200**, and
   `GET /account/payment_methods` then correctly listed `bank_debit: ["ach"]`
   alongside card. So the configuration layer accepts it.
2. Every confirm still failed, on every connector:

   ```
   {"error":{"type":"invalid_request","message":"Payment method type not supported","code":"IR_19","reason":"The payment method bank_debit is not supported is not supported by fauxpay"}}
   ```

   …and identically for `paypal_test`, `stripe_test` and `pretendpay`. The
   same four also reject `bank_transfer`/`ach` (the push-payment variant).
3. `GET /feature_matrix` explains why. All four connectors on this profile are
   Hyperswitch **dummy** connectors, which implement cards only. The
   connectors whose integrations support `bank_debit`/`ach` are:

   **adyen, stripe, gocardless, dwolla, stax, payload, wellsfargo** — every
   one of which needs real credentials from that processor's own sandbox.

So this is not a toggle anyone forgot to flip. **Completing the ACH happy
path requires signing up for one of those processors' sandboxes and adding it
as a connector** (GoCardless or Dwolla are the cheapest to obtain; Stripe test
keys also work). The connector configuration was restored to its original
card-only state afterwards, so the account is exactly as it was found.

**What *was* verified about the success path**, so that adding a connector is
the only remaining step:

- The publishable key is accepted on `POST /payments/{id}/confirm` from the
  browser — the request authenticates and routes; it is not rejected as
  unauthorized.
- Hyperswitch deserializes the `ach_bank_debit` body strictly, and the shape
  the code sends is the one it expects. Removing or renaming `routing_number`
  returns `IR_06 "Json deserialize error: missing field `routing_number`"`,
  while the shape in `confirmAchPayment` passes deserialization and reaches
  connector routing. The request body is therefore correct up to the
  connector.
- `110000000` / `000123456789` are the standard ACH test values and are the
  first thing to try once a connector is added — still unverified against a
  real authorization, by definition.

Once a connector is added, nothing in the code needs editing: the payment step
reads availability from the account, so ACH turns itself on. The expected
happy path is then **`processing`, not `succeeded`** — an ACH debit is
accepted now and settles over 3–5 business days, so the storefront shows
"Transfer submitted", holds the seats, and only flips the order to `paid` on
the settlement webhook.

## Notes

- **ACH availability is not hardcoded.** `GET /api/payment-capabilities`
  (`apps/api/src/services/achAvailability.ts`) cross-references the merchant's
  connectors against `GET /feature_matrix` and reports both a student-facing
  sentence and an operator-facing diagnosis. Both of its negative branches
  were verified live: with ACH disabled it reports the IR_39 case; with ACH
  enabled on `stripe_test` it reports "enabled on stripe_test, but that
  connector's integration does not support it — a confirm would fail with
  IR_19". Checking only whether the method is *enabled* would light the button
  up for exactly the misconfiguration in point 1 above.
- Card number, expiry and CVC are collected entirely inside Hyperswitch's
  hosted card element — never typed into our own API. **Pay is not gated on
  card completeness**, because the SDK gives us no way to observe it (next
  note); it gates on the hosted iframe having painted and on our own billing
  fields being filled. An incomplete card is caught by `confirmPayment`
  rejecting, and that message is surfaced to the student.
- **The browser widget is verified live** (2026-09-09, against
  `https://beta.hyperswitch.io/v1/HyperLoader.js` — note the SDK is served
  from a different host than the REST API, which 404s on that path).
  Confirmed: the global really is `window.Hyper`, and `elements.create("card")`
  mounts one iframe holding card number, MM/YY and CVC, whose fields accept
  input. Also confirmed, and the reason the Pay-button gating changed: the
  element emits **`ready`, `focus` and `blur` only** — there is no
  Stripe-style `change` event carrying `{ complete }`. Gating Pay on one left
  the button disabled forever.
- Routing and account numbers are ordinary labelled inputs, not a hosted
  element, and ACH confirms via `confirmAchPayment` rather than the SDK.
  That's deliberate: bank data sits outside PCI's cardholder-data scope, and
  it still goes from the browser to Hyperswitch rather than through our API.
  Mounting Hyperswitch's unified `payment` element there was tried and
  reverted — on this account it renders a *card* form, which under a "Link
  your bank" heading would invite someone to type card data into what they
  believe is a bank transfer.
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
