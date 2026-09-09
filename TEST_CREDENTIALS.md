# Sandbox test credentials

Values to punch into the Payment step's hosted fields when testing "New
card" and "Bank transfer (ACH)" against the Hyperswitch **sandbox**
environment. Nothing here is a secret — these are publicly documented test
values that exist specifically so they never touch a real account.

**Unverified:** these are the standard values Hyperswitch's own docs point
to for a sandbox merchant account, and they line up with the test data used
across most of the connectors Hyperswitch integrates with test cards from
(Stripe, Cybersource, Checkout.com, etc. all use `4242...4242` for a generic
success case). They have **not** been run through this specific merchant
account's configured connector yet — see `ENDPOINTS.md`'s "Outstanding
before this doc is fully 'Working'" section. If a value below is declined,
check **Hyperswitch Dashboard → Connectors** for which processor is live on
this account and pull that connector's specific test cards from
[Hyperswitch's test-cards reference](https://docs.hyperswitch.io) instead.

## New card → succeeds

| Field | Value |
|---|---|
| Card number | `4242 4242 4242 4242` |
| Expiry | any future date, e.g. `12/34` |
| CVC | any 3 digits, e.g. `123` |
| ZIP (if asked) | any 5 digits, e.g. `94103` |

### Card decline (for negative-path testing)

| Field | Value |
|---|---|
| Card number | `4000 0000 0000 0002` |
| Expiry / CVC | same as above |

## Bank transfer (ACH) → succeeds

| Field | Value |
|---|---|
| Routing number | `110000000` |
| Account number | `000123456789` |
| Account holder name | any name |
| Account type | Checking |

### ACH failure cases (for negative-path testing)

| Scenario | Account number |
|---|---|
| Insufficient funds | `000111111113` |
| Account closed | `000111111116` |

## Notes

- These fields are collected entirely inside Hyperswitch's hosted
  card/payment element — never typed into our own API. Confirm stays
  disabled until the element reports the field(s) as complete (see
  `apps/web/src/pages/PaymentPage.tsx`), so nothing is sent to Hyperswitch
  until you've actually filled these in and clicked **Confirm & pay**.
- ACH in the sandbox is expected to resolve to `processing` rather than an
  instant terminal result — the UI's polling window (30s) may time out and
  tell you to check back; that's expected sandbox behavior, not a bug.
- "Card ending 4242 (saved)" in the UI reflects a real saved Hyperswitch
  payment method for the seeded student, created the first time a `New
  card` payment above is confirmed successfully — it isn't a hardcoded row.
