Higher Education Tuition Payments — Architecture & Decisions
Hyperswitch sandbox prototype · US market · Courses → Review → Payment
1. The Industry, and Why
Higher-education tuition is a distinct payments niche, not generic e-commerce with a school logo. Charges are large and infrequent — a few thousand dollars, a few times a year — rather than small and frequent. The invoice is assembled from several inputs (tuition, mandatory fees, financial aid credits), so what a student owes is a computed balance, not a listed price. The person paying is often not the account holder: parents, guardians, and employers routinely pay on a student's behalf. Institutions are unusually explicit about steering payment method by cost — interchange on a $4,000+ card payment is real money, so schools commonly waive fees for ACH and pass a convenience fee to card payers, a dynamic rarely spelled out this directly in consumer checkout. Two compliance regimes apply at once: PCI-DSS for the card data, FERPA for the education record it's attached to. And volume is bursty — most of a term's transactions land in the handful of days around the due date, not smoothly across the calendar. These five properties — computed balances, third-party payers, fee-sensitive method steering, dual compliance regimes, and calendar concentration — drove the choices below, more than generic checkout-UX conventions.
2. The Flows This Industry Needs
Itemized invoicing — tuition, fees, and aid credits rolled up into a computed balance due.
Multiple funding sources on one invoice — self-pay (card/ACH), financial aid, 529/education savings, third-party or authorized payer.
Fee-differentiated payment methods — ACH free, card surcharged.
Term-length installment / payment plans — split a balance across several scheduled charges.
Saved payment method, reused every term without re-entry.
Refunds tied to the add/drop and withdrawal calendar, not a flat policy.
Failed-payment dunning and registration holds. 
Itemized receipts / statements for recordkeeping and 1098-T tax reporting.
Delegated, FERPA-safe access for authorized (non-student) payers.
3. What I Built vs. Deferred, and Why
Built — the core flow, end-to-end, against the live Hyperswitch sandbox
Three-step journey — Courses → Review → Payment — with free backward navigation until the payment is submitted, matching the reference wireframe.
Course selection is intentionally a flat add/remove list — no time-conflict or prerequisite checking. That's a student-information-system problem, not a payments one, and was out of scope by design.
Review is the invoice source of truth — tuition + lab fee + admin fee, minus a financial-aid credit, producing a server-computed balance due that the client never overrides.
Payment processes real Hyperswitch sandbox transactions for: a saved card (returning-student one-click) or a new card via Hyperswitch's hosted fields; ACH bank transfer, presented as the no-fee option; and a “split into 4 payments” merchant-financed installment plan.
Order status is webhook-driven, not redirect-driven — the order only flips to Paid when Hyperswitch confirms server-to-server, so a closed tab or dropped connection can't fake a completed payment.
An itemized PDF receipt is generated once the order is marked Paid.
Deferred — real flows for this industry, called out rather than faked
“529 plan credit” as a live, one-click payment method. No processor, Hyperswitch included, can pull funds from a 529 in real time — a plan administrator disburses by ACH or check, days to weeks later. Rather than fake this as a Hyperswitch payment, I'd model it as a funding request: the balance moves to a “Pending 529” state and clears via a reconciliation job when funds actually land in the school's account. Presenting it as an instant payment method, as the wireframe does, would misrepresent how the money moves.
Authorized / third-party payer. A scoped, login-less “pay this invoice” link for a parent, with FERPA-consented access limited to one invoice rather than a full student account.
Refunds and withdrawal proration. Hyperswitch's Refunds API is the easy part; the real work is a policy engine (100/50/0% by drop date) tied to the academic calendar, which should exist before the refund call is wired up.
Installment dunning and registration holds. Hyperswitch's webhooks and smart retries are the right primitives, but a scheduler/dunning service and a hold flag on the student record are new surface area, deferred for time.
Multi-payer split invoices (e.g., parent covers half). Needs partial-payment tracking per invoice, not just per Payment Intent.
Enforced surcharging. The “no fee” ACH messaging in the prototype is presentational; production would enforce it with Hyperswitch's surcharge configuration rather than a static label.
4. Hyperswitch Integration & Payment-Method Choices
Server-authoritative Payment Intents. The storefront backend prices the cart and creates the Payment Intent server-side at the Review → Pay transition, from its own line items — the client never supplies an amount. For a “real completed payment,” this is non-negotiable: a client-supplied amount is the most common fraud vector in tuition payment portals.
Hosted card fields, not raw HTML inputs, via Hyperswitch's client SDK — keeps PCI scope at SAQ-A, appropriate for a school payment portal handling a captive audience's card data every term.
Card and ACH as payment methods on one integration, not two vendor integrations. This is Hyperswitch's core value proposition earning its keep here: card and ACH have completely different settlement timelines (seconds vs. days) behind a single Payments API, instead of wiring a card processor and a separate ACH provider by hand.
Status handling built around Hyperswitch's payment-status states, not a binary paid/unpaid. ACH intents sit in a processing state before they succeed or fail; the UI shows “processing,” and the order finalizes only on the terminal webhook. Card confirms same-session — treating the two identically was the wrong instinct to design around.
Installments via saved-payment-method mandates, not a BNPL connector. Real tuition installment plans (Nelnet, TouchNet) are financed by the institution itself, not a third-party lender — routing through an Affirm/Klarna-style BNPL connector would quietly create a consumer-lending relationship (Reg Z, state licensing) the school hasn't taken on. Instead: the first installment is a customer-initiated transaction that also saves the payment method (mandate); the remaining three are merchant-initiated transactions charged against that mandate on a schedule. This is exactly what Hyperswitch's CIT/MIT mandate model exists for, and it's the right mental model for merchant-financed installment plans generally, not just here.
Tokenized Hyperswitch Customers, one per student, reused every subsequent term — the “Card ending 4242 (saved)” option is this.
One test connector per method for the prototype; production is where Hyperswitch's smart routing and failover across multiple live connectors earn their keep — tuition volume concentrates into a few due-date days a term, a narrower, higher-stakes version of Black Friday, where processor failover matters more than on a smoothly distributed storefront.
5. How the Prototype Fits Together, End-to-End
Components: a three-step storefront SPA; a storefront API that owns invoicing and order state (Draft → Reviewed → Payment Pending → Paid / Processing / Failed); Hyperswitch (Payment Intents, Customers, Mandates, Webhooks); one card and one ACH-capable sandbox connector; a receipt generator.
1. Student adds/removes course sections client-side — no server call needed yet.
2. On Review, the client asks the storefront API to price the cart; the API returns the itemized invoice and balance due — the numbers rendered are the numbers later charged.
3. On Payment, the client asks the storefront API for a Payment Intent scoped to that balance; the API creates it server-side with its secret key and returns a client secret.
4. The client renders Hyperswitch's hosted fields (card) or the ACH / saved-card / installment options, and confirms the intent directly with Hyperswitch using the client secret — card data never touches the storefront API.
5. Hyperswitch routes to the sandbox connector; card returns a result in-session, ACH returns “processing.”
6. Hyperswitch sends the storefront API a signed webhook on the terminal status; the API verifies it, updates order state, and, if paid, generates the itemized PDF receipt.
7. For the installment plan, steps 3–6 repeat automatically at 30-day intervals as MIT charges against the stored mandate, each posting its own webhook-driven ledger entry against the same invoice.
Data model: Student · Term · Invoice (line items incl. aid credit, computed balance_due) · Order · Payment (Hyperswitch payment_id, method, status, amount) · InstallmentPlan (mandate_id + schedule) · Receipt.
