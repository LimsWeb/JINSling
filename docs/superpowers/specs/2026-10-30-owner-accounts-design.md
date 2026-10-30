# Owner-managed accounts and password login

## User request and authorization

The user explicitly requested ordinary username/password registration, one-time owner approval, unattended later login, clarification of administrator operations and capacity, owner-controlled private data, and a future AI reservation path. Strict zero monetary cost and no running local server remain requirements. Reversible implementation is authorized; no external account or paid plan is created by this work.

## Approach and builder decisions

Keep Cloudflare Pages/Functions and D1 booking transactions. Use Firebase Authentication **Spark** as the production password provider. Standard password KDF work is unsuitable to assume within Workers Free's CPU/hosted PBKDF2 limits; do not replace it with SHA256 of human passwords. Google Sheets is optional owner reporting, while D1 remains the authoritative store enforcing reservation conflicts. These are implementation decisions, not claims that the user selected a vendor.

The UI collects a unique username and password, not a real email. The provider maps the normalized username to a deterministic non-deliverable email-shaped alias under `jinsling-auth.invalid`; this is an application adapter over Firebase email/password, not native Firebase username support. Alias acceptance and actual provider operations require an owner Spark project integration check before launch. No verification emails, SMS, social login, or recovery emails are sent.

Alternative: keep random login keys (does not meet the requested UX). Self-hosted password hashing or a paid Worker violates the operating constraint. A private Google Sheet backend would require additional transaction/locking and authentication work without creating a stronger ownership boundary.

## Account behavior

- Username: ASCII letters/digits/underscore, 4–32 characters; canonical lowercase, case-insensitive uniqueness. Password: 15–128 Unicode characters, preserved without trimming, no composition rule. Password manager autocomplete supported.
- Open registration creates a pending member; owner approval occurs once. Pending members may log in and see their status, but cannot book. Approved members log in independently at any time. Owner can close new registration.
- Public member data: id, username, name, phone, role, status, created_at, needs_password_setup, password_reset_required. Provider UID and credential/reset/session secrets are never exposed.
- Owner sees name, phone, username, approval status, registration date, and password-reset action. Passwords are never displayed or exported, including to the owner.
- Owner reset: cryptographically random 256-bit single-use reset link, 24-hour expiry. D1 stores only its hash. Issuing reset immediately revokes app sessions and blocks ordinary login until reset completion. User selects the new password. Approval status remains unchanged. Tokens use URL fragments, cleared immediately on page entry.
- Own password change verifies the current password, invalidates all old app sessions, and issues a replacement session. Failure across provider/D1 must fail closed, preserving profile/bookings; a valid reset/recovery path must remain possible.
- Existing key-only accounts keep their user and booking IDs. A restricted legacy login allows choosing username/password once; after conversion the old key is refused. No silent database reset or weak default passwords.
- New registered-account limit is **100 by default**, configurable **1–1,000 including the owner and all stored account statuses**. Existing configured values migrate to at least 100. This is an application admission limit, not a benchmark or provider maximum. Weekly 70 is not a limit; daily 18/10 capacity stays separate.

## Production password provider interface

`createPasswordAuth(env)` in `web/server/password-provider.mjs` returns the trusted injected `env.AUTH` (tests/dev only) or the Firebase adapter. `passwordAuthReady(env)` reports configuration readiness.

Provider methods:

```text
createUser({username,password}) -> {uid}
verifyPassword({username,password}) -> {uid}
setPassword({uid,password}) -> void
deleteUser({uid}) -> void
```

`AuthProviderError.code` is `INVALID_CREDENTIALS`, `USERNAME_TAKEN`, `UNAVAILABLE`, or `NOT_CONFIGURED`. Errors must not include provider response bodies, keys, passwords or tokens. Firebase configuration uses owner-controlled `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON` secrets. Calls use only fixed Google HTTPS endpoints. Privileged changes use the service account OAuth token, without a Node SDK in production. Match Firebase UID and project from the server's own HTTPS login response; never trust a browser-asserted UID/token. No client-side password storage.

Local dev provider uses persistent SQLite and a strong Node password KDF, solely for synthetic preview. Production never falls back to it.

## API delta

Keep response envelopes, same-origin mutation checks, secure cookies, booking endpoints, roles and SQL booking guards.

| Method/path | Input | Result |
|---|---|---|
| GET /api/session | — | add `auth_ready`, user safe flags, settings `member_limit` and `registration_open` |
| POST /api/bootstrap | setup_token,name,phone,username,password | user and session cookie; no plaintext generated credential |
| POST /api/auth/join | name,phone,username,password,invite_token? | pending user and session; invitation optional |
| POST /api/auth/login | username,password OR legacy login_key | user and cookie; legacy has restricted setup access |
| POST /api/auth/setup-password | username,password; legacy cookie | convert same account and replace session |
| POST /api/auth/change-password | current_password,new_password; cookie | replace own password/session, keep status |
| POST /api/auth/reset-info | reset_token | valid,expires_at (no account profile) |
| POST /api/auth/reset-password | reset_token,new_password | user and replacement session |
| POST /api/admin/users/:id/reset-password | {} | reset_token,expires_at (shown once) |
| GET /api/admin/members.csv | — | name,phone,username,status,created_at,password_reset_required; no auth material |

Remove the old key-rotation action for converted accounts. Existing invite links may remain supported, but signup does not require one. Settings API replaces `pilot_member_limit` with `member_limit`, adds Boolean `registration_open`; old DB column may remain unused for migration compatibility. Full settings: shop_name,contact_phone,booking_window_days,cancel_before_minutes,member_limit,registration_open. Public shop contact stays optional and blank by default; it is not the owner's private profile phone.

## Persistence and races

Keep `0001` immutable and add ordered `0002` migration, with upgrade tracking in the local adapter. Add username, provider UID, credential revision and reset state as needed. Legacy key_hash may remain as an inaccessible random compatibility digest for converted users. Replace affected old account/settings triggers and audit shapes; never add credentials to audit.

Tests must prove one-time approval, more than five users, preservation of old IDs/bookings, no session issued after an overlapping reset/suspension, single-use reset, failure/compensation between Firebase and D1, and no password/reset leakage. Do not claim cross-service atomicity; use conditional writes, locks or fail-closed recovery for provider/DB boundaries.

## Owner privacy and future AI

Production Cloudflare, Firebase, production repository, secrets, exports, backups and deploy authority belong to the shop owner. Developer only has the development repo and synthetic data. A developer with deploy authority can make the program read its bound DB; UI role restrictions or hiding D1 permission alone do not prevent this. No automatic release from a developer-writable repo into production. Owner accepts reviewed updates and publishes them using owner-controlled access.

CSV can be imported into the owner's private Google Sheet. This update does not implement a second live Sheet database or external data synchronization.

AI is a documented extension point only. It should resolve intent/date/time, call the same authenticated availability/booking APIs, and obey approval/ownership/conflict/cap checks. An external agent later needs scoped delegation, expiry/revocation and explicit audit identity. It never receives the member database, owner cookie, passwords or direct DB write permission. AI costs need a separate free-only quota decision; no model provider is activated now.
