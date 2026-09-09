# Juspay Take-Home — Tuition Payments

Higher-ed tuition storefront (Courses → Review → Payment) integrated against
the Hyperswitch sandbox. See [`project-description-architecture.md`](./project-description-architecture.md)
for the full design rationale — read it before making structural changes.

## Layout

```
apps/
  api/      Express + TypeScript storefront API — owns invoicing and order
            state, creates Hyperswitch Payment Intents server-side, verifies
            webhooks. SQLite via Prisma for the prototype.
  web/      React + Vite SPA — the three-step storefront. Confirms payments
            directly with Hyperswitch using hosted fields; card data never
            touches apps/api.
packages/
  shared/   TypeScript types shared between web and api (Invoice, Order,
            Payment, InstallmentPlan, Receipt, ...) and the API's request/
            response contracts.
```

## Setup

```bash
npm install
cp apps/api/.env.example apps/api/.env       # fill in Hyperswitch sandbox keys
cp apps/web/.env.example apps/web/.env

npm run prisma:migrate                        # creates apps/api/prisma/dev.db
npm run --workspace apps/api seed             # seeds a student, term, course sections
```

## Run

```bash
npm run dev:api   # http://localhost:4000
npm run dev:web   # http://localhost:5173
```

## Status

This is a scaffold: routes and data model are wired end-to-end. As of
2026-09-09, `POST /api/orders/payment-intent` has been verified against a
live Hyperswitch sandbox call (`apps/api/src/services/hyperswitch.ts`) —
real keys create a real Payment Intent with the expected `payment_id` /
`client_secret` shape. Still unverified: the client-side hosted-fields
confirmation (`apps/web/src/lib/hyperswitch.ts`, `window.Hyper` global and
Elements API) and the incoming webhook path, which needs either a completed
client-side payment or a tunnel (e.g. ngrok) so Hyperswitch can reach this
machine. See architecture doc §3 for what's intentionally built vs. deferred.
