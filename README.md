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

`prisma:migrate` also generates the Prisma client, which `apps/api` needs to
typecheck. If you run `npm run typecheck` or `npm run build` on a fresh clone
*before* migrating, it fails on missing Prisma types — run
`npm run prisma:generate` first. (`render.yaml` already does this in its build
step.)

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
silently. Three things are worth deciding on before relying on a deploy:
SQLite persistence on Render (see that comment block), the fact that no
scheduler is wired up yet for the installment auto-charge endpoint
(`POST /api/installments/run-due` expects to be called by external cron —
see [`ENDPOINTS.md`](./ENDPOINTS.md)), and Render's free-tier cold starts,
which can delay webhook delivery enough to matter.

## Status

**Card payments work end to end against the live Hyperswitch sandbox.** As of
2026-09-09, both halves are verified: `POST /api/orders/payment-intent`
creates a real Payment Intent server-side, and the browser SDK
(`apps/web/src/lib/hyperswitch.ts`) mounts a real hosted card element and
confirms it — `4242…` succeeds on the `fauxpay` connector, the decline card
returns `DC_08`. Order state then advances only on server-to-server
confirmation, and a paid order produces an itemized PDF receipt.

Two methods are built but cannot complete a payment yet, and both say so in
the UI rather than failing silently:

- **ACH** — no bank-debit connector is enabled on this merchant profile, so
  confirming returns `IR_39`. It's a dashboard fix, not a code change; see
  [`TEST_CREDENTIALS.md`](./TEST_CREDENTIALS.md).
- **The 4-payment installment plan** — the intent is created for the full
  balance rather than the first installment, and the first charge doesn't
  request a mandate, so payments 2–4 are never taken. Selecting it charges
  the whole balance today and the page says so.

Still unverified: the incoming webhook signature path, which needs a real
delivery from the dashboard against a publicly reachable URL (a tunnel such
as ngrok stands in during development). Order status still resolves without
it, via the API's own `force_sync` reconciliation.

See architecture doc §3 for what's intentionally built vs. deferred, and
[`ENDPOINTS.md`](./ENDPOINTS.md) for the route-by-route state.
