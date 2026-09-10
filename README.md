# Higher-Ed Tuition Payments

A three-step tuition storefront (Courses → Review → Payment) integrated
against the Hyperswitch sandbox.

**Live demo:** https://higher-ed-payments-demo.netlify.app/
Test card/bank values are in [`FAKE_CREDENTIALS.md`](./FAKE_CREDENTIALS.md).

## Layout

```
apps/
  api/      Express + TypeScript storefront API — invoicing, order state,
            server-side Hyperswitch Payment Intents. SQLite via Prisma.
  web/      React + Vite SPA — the storefront. Confirms payments directly
            with Hyperswitch using hosted fields; card data never touches
            apps/api.
packages/
  shared/   TypeScript types shared between web and api.
```

## Run it locally

```bash
npm install
cp apps/api/.env.example apps/api/.env       # fill in Hyperswitch sandbox keys
cp apps/web/.env.example apps/web/.env

npm run prisma:migrate                        # creates apps/api/prisma/dev.db
npm run --workspace apps/api seed             # seeds a student, term, courses

npm run dev:api   # http://localhost:4000
npm run dev:web   # http://localhost:5173
```

Both apps read their integration points from env vars (`VITE_API_BASE_URL`,
`CORS_ORIGIN`) — no hosts are hardcoded. `render.yaml` and `netlify.toml` at
the repo root deploy this as-is on Render + Netlify.

## Status

Card payments and the installment plan's first charge work end to end
against the live Hyperswitch sandbox. ACH is built but has no ACH-capable
connector on this sandbox account, and installment payments 2–4 need someone
to trigger `POST /api/installments/run-due` — see `FAKE_CREDENTIALS.md` for
exactly what does and doesn't complete. Full design rationale and what's
deliberately deferred: `project-description-architecture.md` (kept out of
the public remote — ask if you'd like a copy).
