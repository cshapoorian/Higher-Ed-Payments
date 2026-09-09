# Juspay Take-Home — Tuition Payments

Higher-ed tuition storefront (Courses → Review → Payment) integrated against
the Hyperswitch sandbox. See [`project-description-architecture.md`](./project-description-architecture.md)
for the full design rationale — read it before making structural changes, and
[`ENDPOINTS.md`](./ENDPOINTS.md) for which API routes exist today versus what
still needs to be built.

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

## Hosting elsewhere

Both apps read their integration points from env vars, not hardcoded hosts:
`apps/web` calls the API at `VITE_API_BASE_URL`, and `apps/api` accepts
browser requests only from the origin(s) in `CORS_ORIGIN` (comma-separated;
defaults to `*` for local dev; an entry starting with `*` matches by suffix,
e.g. `*--your-site.netlify.app` for Netlify deploy previews). Point both at
your deployed API host when hosting the SPA and API separately, and lock
`CORS_ORIGIN` down to the SPA's real origin once it has one.

### Render (apps/api) + Netlify (apps/web)

`render.yaml` and `netlify.toml` at the repo root are ready to deploy as-is —
connect this repo as a Blueprint in Render and as a site in Netlify and both
pick up their build/start config automatically. Both files have inline
comments on the required env vars and known tradeoffs; **read the comment
block at the top of `render.yaml` before deploying** — it covers a real
data-loss gap (SQLite + Render's free tier) rather than just applying a fix
silently. The full list of things worth deciding on together before/after
first deploy is in the project handoff notes (ask if you don't have them);
short version: SQLite persistence on Render, no scheduler is wired up yet for
the installment auto-charge endpoint, and Render's free-tier cold starts can
delay webhook delivery.

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
