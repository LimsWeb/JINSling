# Implementation status — 2026-10-30, account update

## Authorized outcome

The user requested username/password signup with one owner approval, ordinary unattended later login, owner administrator operations, more than five members, owner-only production data management, and a future AI reservation path. Strict zero monetary cost and no always-on local server remain requirements. This update implements that account change in the isolated `jinSling-v2` worktree on `feat/free-pilot`; the original Python source is retained.

## Implemented

- Username/password registration and login without real-email or SMS collection. Approval happens once. Pending users can see their status; approved members can book without an administrator being online.
- Firebase Authentication Spark production adapter using fixed HTTPS REST endpoints and service-account OAuth for password changes. Trusted synthetic authentication is injected only in development/tests; production has no local fallback.
- Owner-issued 24-hour single-use reset links, own password change, session invalidation and conditional credential revisions. Passwords never appear in profiles, audit or CSV.
- Additive 0002 migration and legacy key-to-password conversion preserve IDs, approval and reservations. Converted users cannot reuse their old key.
- Default account admission 100, configurable up to 1,000, independent of the four/five-person first trial and daily appointment limits. Registration can be closed.
- Owner member table and CSV; public shop phone is separate from the owner's private profile phone.
- Existing member-linked manual bookings, schedule changes, cancellations, daily caps, breaks, audit and reservation CSV retained.
- Owner-controlled deployment/data handoff and Google Sheets manual CSV option documented. No automatic Sheets synchronization or AI model was activated.

## Verification

Final automated test results and browser evidence are recorded in [VERIFICATION.md](VERIFICATION.md). The integrated suite includes 16 account tests, 14 API/reservation tests, 10 provider tests and 11 UI utility tests. A separate reviewer examined provider identity trust, credential races, migration, offline recovery, UI and final handoff documents.

The developer preview successfully upgraded the previous synthetic key-based accounts in place. Browser checks confirmed username-only forms, pending state, independent approved-member login, owner account controls and default100 setting, member-linked manual reservation appearing in the customer's list, and immediate reset fragment clearing on an already loaded page.

## Production boundaries

- **Not deployed to the shop owner's Cloudflare or Firebase account.** Publishing this source to GitHub does not provision hosting or grant access to production data; no cloud account, payment method or paid plan was created.
- Live acceptance of `jinsling-auth.invalid` Firebase aliases, owner-project permissions, actual Google signup/login/reset, hosted D1 and production HTTPS cookies still require verification.
- Cloudflare Free CPU/request and D1 usage must be measured at launch. The app's maximum1,000 stored-account setting is not a capacity benchmark.
- Firebase and D1 are separate services. Unknown credential mutations stay locked; owner recovery is documented. Partial signup failures can leave an unlinked provider account requiring verified cleanup.
- Actual owner/developer access separation is a deployment condition, not something code alone completes. Owner controls production source/release, cloud accounts, secrets, logs and backups.
- Physical mobile use and the first four/five-person trial remain launch acceptance tasks.

## Next concrete operating step

The owner creates or selects their own Cloudflare Free and Firebase Spark projects, keeps billing unlinked, applies the migrations, registers secrets privately, and runs the live acceptance steps in [DEPLOY_FREE.md](DEPLOY_FREE.md). Development continues with synthetic data and the owner accepts reviewed releases into their controlled production repository.
