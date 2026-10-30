# Owner Accounts Implementation Plan

> **For agentic workers:** use subagent-driven-development with disjoint file ownership; root integrates and performs final verification.

**Goal:** Username/password membership with one-time approval, owner-only operations and clear capacity/privacy boundaries, retaining zero-cost hosting.

**Architecture:** Firebase Spark password adapter + existing D1 authorization/booking API. Development/test provider is explicitly separate. Owner controls production releases and data.

**Tech Stack:** Web-standard ESM, Cloudflare Pages/Functions/D1, Firebase Auth REST, Node24 SQLite for tests/dev.

**Spec:** docs/superpowers/specs/2026-10-30-owner-accounts-design.md

## Global constraints

- No paid account, live customer data or external mutation; no operating local server.
- Username 4–32 ASCII letters/digits/underscore canonical lowercase; password15–128 characters, never trimmed.
- Member limit100 default, max1000, all stored statuses; daily appointment limits unchanged.
- No plaintext passwords in D1/logs/exports, no weak password KDF, no demo provider in production.
- Real Firebase/Cloudflare/account-ownership enforcement remains a deployment gate, not a local test claim.

## Review focus

1. Reset overlaps in-flight login or a second reset: no unauthorized new session or unintended unlock.
2. Provider succeeds but D1 fails: preserve records and fail closed with recovery path.
3. Old0001 database upgrades without losing IDs/bookings, old keys stop after conversion.
4. Wrong Firebase project/UID or provider error cannot authenticate another member.
5. Owner-only data claim includes deployment/repo authority; API/export never exposes password/reset material.

## Task 1: Password provider

**Files:** web/server/password-provider.mjs; web/dev/password-auth.mjs; web/tests/password-provider.test.mjs.
**Interface:** exact provider interface/configuration in spec. Development factory `createDevelopmentAuth(filename=':memory:') -> {auth,close}`; persistent strong password verifier; auth methods same interface.

- [x] Add focused failing tests for Firebase HTTPS request/response identity, provider error sanitization, protected admin requests, configuration absence and dev password verification.
- [x] Implement Firebase REST/OAuth WebCrypto adapter and persistent local dev provider. Verify exact privileged endpoints against primary docs.
- [x] Run owned tests and project suite; report actual failures and external unverified parts. No commit by subagent.

## Task 2: Membership backend and migration

**Files:** web/server/api.mjs, support.mjs, new account helper module if useful; web/migrations/0002_accounts.sql; web/tests/sqlite-d1.mjs, api.test.mjs, accounts.test.mjs; web/scripts/generate-recovery-key.mjs.
**Consumes:** Task1 provider interface; may use a narrow explicit test-provider stub only for external service behavior, with real SQLite business outcomes.

- [x] Write and witness failing tests for account creation/login/approval, reset/suspension races, provider failure, upgrade and legacy conversion, capacity, private CSV and offline recovery.
- [x] Implement additive migration/triggers and API delta; retain booking checks and IDs. Owner recovery must support converted admin reset and existing legacy admin recovery.
- [x] Update existing API tests to new credentials, retain old booking/security assertions; execute integrated suite after provider lands.
- [x] Report schema/API names and recovery files to root/UI. No staging/commit.

## Task 3: Customer and owner UI

**Files:** web/public/app.js, ui-utils.mjs, style.css, index.html; web/tests/ui-utils.test.mjs.

- [x] Implement username/password signup/login, single approval wording, legacy conversion, private password reset/change, safe reset-fragment clearing.
- [x] Add owner username/join date/reset action and member CSV, new settings labels/default/bounds; preserve manual member booking/blocking.
- [x] Show provider-not-ready clearly, no fake production success; one-time reset link shown before any fallible refresh. Match preview username/password identities.
- [x] Test meaningful UI pure logic; root handles real browser flows. No staging/commit.

## Task 4: Integration, ownership handoff and evidence

**Files:** web/scripts/dev.mjs; README and docs/API_CONTRACT.md, DEPLOY_FREE.md, OWNER_GUIDE.md, IMPLEMENTATION_STATUS.md, VERIFICATION.md, OWNER_DATA.md, AI_EXTENSION.md.

- [x] Migrate synthetic preview accounts via legacy credentials without deleting data; use dev provider, never Firebase fallback.
- [x] Document owner Spark setup, secrets, private release control, Sheet CSV boundaries, first approval vs later login, capacity vs throughput and future scoped AI.
- [x] Run integrated tests/check/build and browser auth/registration/reset/owner flows. Independent review, fix material findings.
- [x] Commit locally, export source/patch, clearly report cloud connection and live provider verification pending.

## Completion evidence

Integrated local tests:51/51 pass; JavaScript syntax:20 files; static build succeeds. Independent security/correctness and handoff-document review found and resolved same-document reset fragment navigation. Root browser checks covered signup form, pending/approved login, member controls/settings, member-linked telephone booking and customer lookup, and invalid reset routing/fragment removal. Actual Google credential operations, owner deployment, physical mobile and hosted capacity remain the stated launch gates. See docs/VERIFICATION.md for exact boundaries.
