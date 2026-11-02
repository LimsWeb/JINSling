# Shared calendar and clickable sharing implementation plan

> **For agentic workers:** Use systematic debugging and test-driven development for the assigned boundary. The user's detailed follow-up authorizes these corrections; implementation proceeds in the existing isolated worktree.

**Goal:** Every approved member sees the shop's occupied times without customer details, open booking screens refresh safely, and QR sharing provides usable links.

**Architecture:** Keep Cloudflare Pages/D1 and the existing atomic database guards. Reuse a single availability calculation for one day and a bounded monthly summary; refresh the calendar and slots in place. Render actual HTML links around the QR preview and provide a selectable URL with clipboard fallbacks.

**Tech stack:** Browser JavaScript/CSS, Pages Functions, D1/SQLite, Node tests and Playwright against synthetic local accounts.

## Evidence and design

The screenshots show November 7 and November 14, not two reservations at the same date/time. The exact-date duplicate report therefore needs an independent reproduction. Existing daily availability queries all confirmed reservations, but the booking screen has no periodic refresher and the month grid has no reservation status. The sharing modal renders a plain text div and canvas, so neither is a link.

Use the current booking page as the shared availability calendar rather than exposing the administrator's customer list. Show a reservation count or closure state on each day, and explicit available/booked/blocked/past/full labels on times. Keep the selected full date beside the times and confirmation. Approved users see identical availability; other customers' names, contact details, identifiers and notes remain private. Monthly summaries use one bounded range rather than fetching 31 individual days.

The screen refreshes every 30 seconds while visible and on return/focus. Preserve the memo and focus, invalidate a selected slot when taken, and fail closed after an availability read fails until a successful refresh. A server-side conflict in an already open confirmation offers another-time selection; do not silently retry with a new booking request ID. The server remains the final arbiter of simultaneous requests.

HTML links and the canvas preview open the exact URL in a new tab. Clipboard failure selects a visible readonly URL field. A downloaded PNG remains a bitmap; sharing instructions say to send its copied link alongside it. No external QR or link service receives invitation secrets.

## Tasks

- [x] **Backend:** Add privacy/race/cancellation tests, observe missing calendar/status failures, implement `/api/availability/calendar?month=YYYY-MM` and enriched daily slot statuses. Keep legacy response fields and existing trigger protection.
- [x] **Booking UI:** Reproduce stale slots with two accounts, add monthly status and day detail, refresh in place with selection invalidation and memo preservation, and recover from conflicts without duplicate writes.
- [x] **Sharing:** Test Clipboard API rejection/unavailability, add fallback helper, real URL links and clickable preview; preserve invitation fragments and one-time secret lifetime handling.
- [x] **Verification:** Run all unit tests and actual-browser scenarios for same-date concurrency, stale confirmation, cancellation, blocked times, monthly navigation, clipboard fallback, privacy and mobile layout. Review the complete diff.
- [x] **Delivery preparation:** Build the Pages worker and static files, validate the 14-file upload ZIP, and prepare the reviewed GitHub diff while preserving remote changes. The user deploys the replacement ZIP to the existing production project.

## Review focus

- A day selected in one month must not silently remain selected after navigating to another month.
- A refresh error must not make stale free slots look trustworthy or erase a draft memo.
- A response arriving after navigation/account change must not repaint an old calendar or publish a private link.
- Two customers racing for the same exact date/time must produce one confirmed row; different dates remain independent.
- Clicking an invitation preview must preserve its complete fragment and keep the administrator's current tab intact.

## Constraints

No paid plan or new hosted service, no production customer test writes, no database reset, no Firebase plugin, and no change to the agreement that the developer maintains hosting while the owner operates the app.
