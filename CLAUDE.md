# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A take-home assignment for Juspay: a minimal storefront/app for a sample **higher education** vertical (e.g. tuition, course fees, or similar payments) that takes a user from the purchase journey through to a real, completed payment in the **Juspay Hyperswitch sandbox**.

The goal is to demonstrate:
- Understanding of what the higher-education vertical needs from payments (e.g. large one-time payments, installment/deferred plans, institutional billing, ACH/bank transfers common in US tuition payments, refund/dispute handling).
- Sensible, elegant architecture and integration choices for Hyperswitch, driven by the vertical and the **US market** specifically (payment methods, flows, compliance considerations like PCI scope).
- A working end-to-end prototype of the core purchase-to-payment flow — breadth of a clean core flow over exhaustive feature coverage.

An architecture document exists and will be added to this repo incrementally as the project is built out. Once present, treat it as the source of truth for integration approach and design decisions — read it before making structural changes.

## Status

This repository is currently empty (no code, no framework/language chosen yet). This CLAUDE.md is a starting point — re-run `/init` once the tech stack, build tooling, and initial code are in place so build/test/lint commands and code conventions can be captured here.
