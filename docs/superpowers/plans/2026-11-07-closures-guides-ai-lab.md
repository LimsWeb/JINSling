# Closures, Guides and AI Lab Implementation Plan

> **For agentic workers:** Use test-first verification for booking mutations and permissions. Implement independent paths in parallel, then perform one integrated review.

**Goal:** Add safe bulk closures and in-app Korean manuals, and create a separately deployable AI booking experiment.

**Architecture:** Keep production booking triggers authoritative; insert a closure batch atomically using existing blocks storage. Static guides have no customer-data dependency. The AI lab has its own database, sessions, usage budget and confirmation actions, never an operational endpoint.

**Tech Stack:** Existing Node 24 ESM, Cloudflare Pages/D1, browser HTML/CSS/JS; isolated Worker-compatible AI lab.

**Spec:** `docs/superpowers/specs/2026-11-07-closures-guides-ai-lab-design.md`

## Global Constraints

- No Firebase plugin, paid upgrade, user-data migration, or direct production data access.
- Preserve current bookings, public-calendar privacy, authentication and exact QR URLs.
- Bulk closure: 1–31 dates, today through today+365, Seoul date semantics; full 00:00–24:00, morning 00:00–12:00, afternoon 12:00–24:00, custom 30-minute grid.
- AI lab excluded from production assets, separate Cloudflare name and DB, synthetic members only; model proposes, server validates, person confirms changes.

## Review Focus

- Reservation created after closure preview: atomic save must fail without partial blocks.
- Two overlapping independent block groups: releasing one must leave the other effective.
- Late asynchronous response after modal/account change: must not overwrite a different dialog.
- AI prompt or client role spoofing: must not grant owner access or expose another member's bookings.
- Free AI quota exhaustion/provider failure: no paid fallback, no mutation, usable regular controls.

## Task 1: Bulk closure API

Files: `web/server/closures.mjs`, `web/server/api.mjs`, `web/server/support.mjs`, `web/tests/closures.test.mjs`.

Interface: POST `/api/admin/blocks/preview` and POST `/api/admin/blocks/bulk` consume `{from,to,period,start_time?,end_time?,note?,request_id?}`. Preview returns normalized dates/times/count and non-identifying booking conflicts. Bulk requires UUID request_id and returns created block items and batch_id. GET existing block list includes batch_id for generated groups. DELETE `/api/admin/block-batches/:id` releases only that group's surviving blocks; single-block DELETE remains available.

- [x] Write failing authorization, date/preset, conflict rollback, repeat request, availability and independent-unlock tests.
- [x] Implement module and route integration with existing triggers/atomic batch.
- [x] Run focused and complete node suites; record exact result.

## Task 2: Owner controls and guides

Files: `web/public/app.js`, `web/public/style.css`, new `web/public/closure-controls.mjs` if useful; new `guide.html`, `guide.mjs`, `guide.css`; owner/member docs.

- [x] Add closure presets, range, preview/conflict display, confirm save, and group release, preserving single-block actions.
- [x] Add owner and member guides with search/print, navigation from login/sidebar, approved-member distinction, cancellation timing, phone booking, closures and QR instructions.
- [x] Browser-verify role navigation, close/open/refetch, conflicts, 390px layout and no customer data in guides.

## Task 3: Independent AI lab

Files: `ai-lab/` with independent README, package/build/test/dev scripts, public UI, server, migrations and Cloudflare example configuration.

- [x] Verify free-provider docs and choose a hard-budget integration plus explicitly labeled offline/mock mode.
- [x] Implement role-checked test sessions, read-only tools and expiring confirmation proposals for bookings, cancellation, blocks and member status.
- [x] Test ownership, prompt/client tampering, expiry/replay, same-slot races, audit and provider/quota failure. No real customer data or production calls.
- [x] Add separate setup and acceptance checklist for moving beyond synthetic testing.

## Task 4: Integration and delivery

- [x] Review changes with a fresh agent; resolve concrete important issues and run full suites.
- [x] Build/verify production upload ZIP without AI files; package AI project separately.
- [x] Update GitHub preserving remote changes and deliver durable downloads with honest deployment/AI-connection status.

## Completion evidence

Production: 96 tests, 40 JavaScript syntax checks, 12 real Chromium scenarios; isolated AI lab: 38 tests, 13 JavaScript syntax checks, 8 real Chromium scenarios. Fresh reviews checked atomicity, privacy, asynchronous UI state and AI confirmation/budget boundaries. The duplicate-unlock confirmation race found in review was reproduced, fixed and pinned by a regression test. Both compiled Workers passed API/static-routing smoke checks. Production ZIP has 22 files; the separate lab starter includes a 7-file Pages ZIP, fresh-DB SQL and setup notes. Owner/member PDFs have 4/2 visually checked pages. Cloudflare deployment and live AI model calls remain unperformed and are explicitly documented as the next external setup steps.
