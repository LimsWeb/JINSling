# Implementation status — 2026-11-02, pilot handoff

## Authorized outcome

The current operating agreement is that the developer handles deployment and cloud maintenance, while the shop owner is the sole application administrator for member approval and daily scheduling. The developer retains technical cloud/deployment authority; the app does not make production data technically inaccessible to the developer. Transferring the cloud accounts is optional, not a launch prerequisite. Strict zero monetary cost and no always-on local server remain requirements.

## Implemented

- Username/password registration and login without real-email or SMS collection. Approval happens once. Pending users can see their status; approved members can book without an administrator being online.
- Firebase Authentication Spark production adapter using fixed HTTPS REST endpoints and service-account OAuth for password changes. Trusted synthetic authentication is injected only in development/tests; production has no local fallback.
- Owner-issued 24-hour single-use reset links, own password change, session invalidation and conditional credential revisions. Passwords never appear in profiles, audit or CSV.
- Additive 0002 migration and legacy key-to-password conversion preserve IDs, approval and reservations. Converted users cannot reuse their old key.
- Default account admission 100, configurable up to 1,000, independent of the four/five-person first trial and daily appointment limits. Registration can be closed.
- Owner member table and CSV; public shop phone is separate from the owner's private profile phone.
- Existing member-linked manual bookings, schedule changes, cancellations, daily caps, breaks, audit and reservation CSV retained.
- Developer-maintained deployment and owner application operations are documented separately. The Google Sheets manual CSV option remains unchanged.

## Current pilot and patch status

The user has confirmed initial administrator registration and customer signup/approval on the operating site. The reported missing reservation has no confirmed root cause; a test querying the same booking date succeeds. Do not describe that report as proven data loss or a fixed production defect.

- Application password minimum is now 12 Unicode code points, maximum 128. Spaces and existing longer passwords remain valid. The Firebase console policy was not inspected or changed; if its minimum is still 15, the maintainer must align it to 12 and verify the live flow.
- Member management now offers a reusable public booking QR/PNG and optional seven-day, single-signup invitation QR/PNG. Cards are generated locally without an external QR service. Image download and link copy are separate actions: text inside a PNG is not clickable.
- The administrator schedule defaults to upcoming bookings from today through the booking window, with one-day and seven-day views. Visible pages refresh every 30 seconds and recheck on focus/reconnection; the UI shows the last sync. The administrator’s personal list is explicitly labelled “내 계정 예약”.

## Verification

Dated evidence is recorded in [VERIFICATION.md](VERIFICATION.md). The root integrator reran the final code: 76/76 tests passed, all 26 JavaScript files passed syntax checks, and `git diff --check` passed. Existing reservation atomicity, optimistic versions, blocks, daily limits and duplicate-request protection remain covered. Independent review identified two P2 issues, both corrected; follow-up review found no outstanding material findings.

Real Chromium with the local API, SQLite and synthetic authentication confirmed nine browser flows, including cross-session refresh, failed-connection recovery, form preservation, sharing and reset races. A subsequent mobile check exposed an 883px-wide member table; after the grid fix, separate 390px-viewport and 350px-dialog checks passed. Native-canvas QR decoding passed eight cases; the production-URL PNG also decoded correctly at 1080px and 540px. See the [public booking card](screenshots/booking-share-qr.png).

## Operating boundaries and remaining checks

- Confirm the live 12-character Firebase policy and exercise password change/reset once on an agreed test account.
- On the owner's phone, confirm the same reservation date, refresh/tab-return behavior, and scanning a shared PNG. Then try a small end-to-end reservation/change/cancel flow with the first four/five people.
- Cloudflare Free CPU/request and D1 usage still need operating observation. The app's maximum 1,000 stored-account setting is not a capacity benchmark.
- Firebase and D1 are separate services. Unknown credential mutations stay locked for the documented maintainer recovery procedure. Partial signup failures can leave an unlinked provider account requiring verified cleanup.

The developer maintains releases, cloud configuration and backups. The owner receives the operating URL, application instructions, and a maintenance contact, and handles approvals and schedules. Account transfer is not needed to complete this handoff. See [DEPLOY_FREE.md](DEPLOY_FREE.md) and [OWNER_DATA.md](OWNER_DATA.md).
