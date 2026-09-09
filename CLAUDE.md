# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A take-home assignment for Juspay: a minimal storefront (Courses → Review → Payment) for a **higher-education tuition** vertical, integrated end-to-end against the **Juspay Hyperswitch sandbox**, driven by **US market** payment norms (ACH, card surcharging, installment plans, PCI/FERPA compliance).

`project-description-architecture.md` is the source of truth for integration approach and design decisions (what's built vs. deferred, and why) — read it before making structural changes.

## Repo layout

npm workspaces monorepo (`apps/*`, `packages/*`):
- `apps/api` — Express + TypeScript. Owns invoicing/order state, creates Hyperswitch Payment Intents server-side, verifies webhooks. SQLite via Prisma.
- `apps/web` — React + Vite SPA, the three-step storefront. Confirms payments directly with Hyperswitch via hosted fields.
- `packages/shared` — TypeScript types/contracts shared between web and api.

**Card data never touches `apps/api`** — this keeps PCI scope at SAQ-A and is a deliberate architectural boundary, not an accident. Don't route card fields or raw card data through the API when extending payment flows.

## Commands

Run from the repo root:
- `npm run dev:api` / `npm run dev:web` — run api (port 4000) / web (port 5173) dev servers.
- `npm run build` / `npm run typecheck` — build/typecheck shared → api → web, in that order.
- `npm run prisma:migrate` / `npm run prisma:generate` — Prisma migrations for apps/api.
- `npm run --workspace apps/api seed` — seeds a student, term, and course sections.

No test suite exists yet — verify changes by running the dev servers, not a test command.

## Setup

Copy `apps/api/.env.example` → `apps/api/.env` and `apps/web/.env.example` → `apps/web/.env`, then fill in `HYPERSWITCH_*` sandbox keys before running migrations or dev servers.

## Gotchas

- Order status flips to `Paid` only on server-to-server confirmation from Hyperswitch — its verified webhook (`apps/api/src/routes/webhooks.ts`), or the API's own `force_sync` check in `GET /orders/:id`. Never on the client's redirect or `confirmPayment` result; don't "fix" payment confirmation by trusting either.
- The Hyperswitch client SDK does **not** emit a Stripe-style `change` event with `{ complete }` — only `ready`, `focus`, `blur` (verified live 2026-09-09). Don't reintroduce a Pay button gated on field completeness; it can never become enabled. Validity comes from `confirmPayment` rejecting, and that message is surfaced to the student.
- The SDK loads from `beta.hyperswitch.io`, not `sandbox.hyperswitch.io` — the latter serves the REST API but 404s on `HyperLoader.js`. See `apps/web/.env.example`.
- ACH is deliberately disabled at the Pay button (`achUnavailable` in `PaymentPage.tsx`): no bank-debit connector is enabled on this merchant profile, so confirm returns `IR_39`. Don't "enable" it in code — it needs a Hyperswitch dashboard change. Equally, don't mount the unified `payment` element for ACH: on this account it renders a *card* form under a bank-transfer heading.
- The installment plan is knowingly incomplete: the intent is created for the full balance (not the first installment) and no mandate is requested, so payments 2–4 never fire. The UI discloses this. If you finish it, fix both halves together — see `ENDPOINTS.md` → "Unfinished inside what's built".
- The incoming webhook signature path is still unverified against a real delivery — don't assume it's correct as written until exercised.
- `npm run typecheck` / `npm run build` fail on a fresh clone until the Prisma client is generated; run `npm run prisma:generate` (or `prisma:migrate`) first.
