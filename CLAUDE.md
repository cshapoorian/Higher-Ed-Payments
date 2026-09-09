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

- Order status flips to `Paid` only on a verified Hyperswitch webhook (`apps/api/src/routes/webhooks.ts`), never on client redirect — don't "fix" payment confirmation by trusting a client-side redirect.
- `apps/api/src/services/hyperswitch.ts` (Payment Intent creation) is verified against a live Hyperswitch sandbox call as of 2026-09-09. `apps/web/src/lib/hyperswitch.ts` (hosted-fields client SDK) and the incoming webhook signature path are still unverified live — don't assume they're correct as written until exercised against a real client confirmation / webhook delivery.
