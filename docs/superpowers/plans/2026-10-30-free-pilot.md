# jinSling Free Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the scoped tasks with verification.

**Goal:** Deliver a working, tested, deployable zero-fee reservation pilot for one shop and 4–5 invited people.
**Architecture:** Static mobile web UI, Pages Functions using a web-standard ESM API, D1 with atomic SQL constraints. Local SQLite adapter for meaningful integration tests and preview, never an operational hosting requirement.
**Tech Stack:** JavaScript ESM, browser APIs, Node 24 test/SQLite for development, Cloudflare Pages Functions + D1 Free for deployment.
**Spec:** `docs/superpowers/specs/2026-10-30-free-pilot-design.md`

## Global Constraints

- No paid plan, credit-card action, paid API, purchased domain, local operational server, or public publication of customer data.
- Asia/Seoul, 30-minute appointments; weekdays initially 09:00–20:00 and 18/day; Saturday 09:00–14:00 and 10/day; Sunday closed. Hours and caps configurable independently.
- Pilot user limit 5 including administrator; do not hard-code weekly 70 as a limit.
- Original Streamlit files preserved. New code under `web/`.
- No plaintext password, default production login, sensitive-token logging, token localStorage, or UI-only authorization.
- Confirmed booking changes atomic, overlapping/cap rules enforced by SQL, cancellation retained in history.
- Actual cloud deployment and local SQLite verification must be reported separately.

## Review Focus

1. Two requests competing for the final slot or the last daily allowance; database must enforce both.
2. Rescheduling into a busy/full date and stale versions; original booking must survive.
3. Past appointments' cancellation/memo edits must not accidentally rebook or be blocked by a future-only rule.
4. Approval/suspension/key rotation must change authorization of already-issued sessions.
5. Hostile name/memo/CSV inputs and cross-origin state changes must remain inert/forbidden.

## Shared API Contract

See `docs/API_CONTRACT.md`; its exact field names and response shapes bind both API and UI.

## Task 1: Real persistence, authentication, booking API

**Files:** Create `web/server/api.mjs`, support modules under `web/server/`, `web/migrations/0001_initial.sql`, `web/tests/api.test.mjs`, `web/tests/sqlite-d1.mjs`. Scope excludes public UI and package/deployment scripts.

**Interfaces:** Export `handleApi(request, env, ctx={}) -> Promise<Response>` from `web/server/api.mjs`; env has `DB` D1-like object and `BOOTSTRAP_TOKEN` optional string. No environment-specific Node imports in server modules. The SQLite adapter is development/test code and implements actual D1-shaped `prepare().bind().first()/all()/run()`, `batch()` transaction, never mocks business outcomes.

- [x] Write failing integration tests for the shared API flows and the five Review Focus risks, execute before implementation and retain evidence.
- [x] Implement schema-only migration with constraint triggers and audit records, then the API handlers. Initialization data goes through bootstrap transaction, not CREATE/ALTER at runtime.
- [x] Rate-limit authentication mutations, validate bounded inputs and phone format, prevent token replay/approval bypass/CSRF/IDOR. Hash generated tokens, issue secure cookies, and enforce pending status on every request.
- [x] Test representative full flows plus independent SQLite connections for racing inserts. Clearly distinguish local SQL concurrency from cloud D1 execution.
- [x] Run `node --test web/tests/*.test.mjs` with clean result; report any runtime/API mismatch immediately.

## Task 2: Usable Korean mobile web UI and preview

**Files:** `web/public/index.html`, `app.js`, `style.css`; `web/scripts/dev.mjs`, `build.mjs`; root `package.json`; `web/functions/api/[[path]].js`; `web/wrangler.example.jsonc` and local configure helper; `web/tests/ui-utils.test.mjs` if actual UI logic needs tests.

**Interfaces:** Consume exactly the shared API contract. Build copies public files into `web/dist/`; Pages Git builds `web/functions/` and imports worker-compatible server modules from source. Preview runs the real API against persistent local SQLite, with clearly labeled synthetic data. Preview-only endpoints are implemented exclusively in dev.mjs; production has no preview endpoint or fixture credentials. The shared browser UI recognizes the optional dev response.

- [x] Build login/join/approval, date/time reservation, own bookings, admin day/week bookings, manual add/move/cancel, hours/caps/blocks, users/invites, history/export.
- [x] All values from users/data rendered as text, not unsafe HTML. Responsive controls, keyboard focus, accessible labels, explicit success/error and no-double-submit.
- [x] Implement output bundling or Pages source layout with no runtime dependencies. Keep Cloudflare bindings and secrets explicit; no project IDs or credentials invented.
- [x] Start only Sites-managed preview; perform real browser customer/admin flows at the available desktop width. Do not claim live deployment.
- [ ] Verify a physical mobile browser and hosted HTTPS after account connection (not available in the current preview tool).

## Task 3: Deployable handoff and final review

**Files:** `web/README.md`, `docs/OWNER_GUIDE.md`, `docs/DEPLOY_FREE.md`, root README and ignore rules.

- [x] Document exact Free-only account setup, Pages Git binding, D1 migration, bootstrap secret, first administrator, test-member invitations, and rollback/export.
- [x] Include no purchased domain/card/SMS requirement. Explain provider limits and 7-day restore vs independent export.
- [x] Run full tests/build, review final diff using a fresh agent, resolve concrete critical/important findings, check tracked files for accidental secrets.
- [x] Commit locally to `feat/free-pilot`. Push/online deploy only through an available authorized connection. If unavailable, provide a truthful handoff without claiming the shop can already use it online.
