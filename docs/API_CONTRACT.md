## Shared API Contract

All API responses: success `{ok:true,data:...}`; error `{ok:false,error:{code,message}}` with appropriate HTTP status. Every POST/PATCH/PUT/DELETE uses JSON and `X-JinSling-Request: 1`. Same-origin cookie credentials. Use snake_case fields throughout.

User public shape: `{id,username,name,phone,role,status,created_at,needs_password_setup,password_reset_required}`; roles `admin|user`; status `pending|approved|suspended|rejected`.
Booking: `{id,user_id,customer_name,phone,date,start_time,end_time,memo,status,version,created_at,updated_at}`. Status `confirmed|cancelled`. No credentials in any public shape.
Settings: `{shop_name,contact_phone,booking_window_days,cancel_before_minutes,member_limit,registration_open}`. `registration_open` is a Boolean.
Weekly rule: `{weekday,closed,open_time,close_time,daily_limit}`; weekday Sunday 0 through Saturday 6.

| Method/path | Input | data result |
|---|---|---|
| GET /api/session | — | `{configured,auth_ready,user,settings}` (user null when signed out) |
| POST /api/bootstrap | `{setup_token,name,phone,username,password}` | `{user}` and cookie; environment `BOOTSTRAP_TOKEN` and password provider required |
| POST /api/auth/login | `{username,password}` OR legacy `{login_key}` | `{user}` and cookie; legacy sessions are password-setup-only |
| POST /api/auth/setup-password | `{username,password}`; restricted legacy cookie | `{user}` and replacement cookie; preserves account ID and bookings |
| POST /api/auth/change-password | `{current_password,new_password}` | `{user}` and replacement cookie; all prior sessions revoked |
| POST /api/auth/reset-info | `{reset_token}` | `{valid,expires_at}`; no account profile |
| POST /api/auth/reset-password | `{reset_token,new_password}` | `{user}` and cookie; single use, approval unchanged |
| POST /api/auth/logout | `{}` | `{}` and expired cookie |
| POST /api/auth/invite-info | `{invite_token}` | `{valid,expires_at}` |
| POST /api/auth/join | `{name,phone,username,password,invite_token?}` | `{user}` and cookie; pending approval, invitation optional when registration open |
| GET /api/availability?date=... | approved user | `{date,slots:[{start_time,end_time,available,status}],booked_count,daily_limit,available_count,closed,status,reason}` |
| GET /api/availability/calendar?month=YYYY-MM | approved user | `{month,days:[{date,booked_count,daily_limit,available_count,closed,status,reason}]}`; one bounded calendar month |
| GET /api/bookings?from=...&to=... | approved user | `{items:[Booking]}`; own only unless admin, default today onward window |
| POST /api/bookings | `{date,start_time,memo,customer_name?,phone?,user_id?,request_id?}` | `{booking}`; admin may manually book |
| PATCH /api/bookings/:id | `{version,date?,start_time?,memo?,customer_name?,phone?}` | `{booking}`; user may edit own memo only |
| POST /api/bookings/:id/cancel | `{version,reason?}` | `{booking}` |
| GET /api/admin/users | admin | `{items:[User]}` |
| PATCH /api/admin/users/:id | `{status}` | `{user}`; cannot disable self/sole administrator |
| POST /api/admin/users/:id/reset-password | `{}` | `{reset_token,expires_at}` displayed once; revoke sessions and require reset |
| GET /api/admin/members.csv | admin | CSV: name,phone,username,status,created_at,password_reset_required; no credentials |
| GET /api/admin/invites | admin | `{items:[{id,created_at,expires_at,used_at,revoked_at}]}` |
| POST /api/admin/invites | `{}` | `{id,invite_token,expires_at}` |
| DELETE /api/admin/invites/:id | `{}` | `{}` |
| GET /api/admin/settings | admin | `{settings,weekly_rules:[Rule]}` |
| PUT /api/admin/settings | `{settings,weekly_rules:[Rule]}` | same result; reject conflicting future confirmed bookings |
| GET /api/admin/blocks?from=...&to=... | admin | `{items:[{id,date,start_time,end_time,note,batch_id?}]}` |
| POST /api/admin/blocks | `{date,start_time,end_time,note}` | `{block}`; reject confirmed-booking conflicts |
| DELETE /api/admin/blocks/:id | `{}` | `{}` |
| POST /api/admin/blocks/preview | `{from,to,period,start_time?,end_time?,note?}` | `{from,to,period,start_time,end_time,dates,count,conflicts:[{date,start_time,end_time}]}`; no writes |
| POST /api/admin/blocks/bulk | same fields plus required UUID `request_id` | `{batch_id,items:[{id,date,start_time,end_time,note,batch_id}]}`; one atomic batch |
| DELETE /api/admin/block-batches/:uuid | `{}` | `{batch_id,count}`; soft-delete only this group; repeat returns count 0 |
| GET /api/admin/recurring-blocks | admin | `{items:[RecurringBlock],schema_ready}` |
| POST /api/admin/recurring-blocks/preview | recurrence fields, optional edit `id,version` | `{rule,occurrences:[{date,start_time,end_time}],conflicts:[{date,start_time,end_time}],conflict_count,can_save}`; no schedule mutation |
| POST /api/admin/recurring-blocks | recurrence fields and UUID `request_id` | `{rule}`; idempotent create |
| PUT /api/admin/recurring-blocks/:id | complete recurrence fields and `version` | `{rule}`; versioned edit |
| PATCH /api/admin/recurring-blocks/:id | `{enabled,version}` | `{rule}`; pause/resume |
| DELETE /api/admin/recurring-blocks/:id | `{version}` | `{}`; soft-delete whole recurrence |
| PUT /api/admin/recurring-blocks/:id/exceptions/:date | `{version}` | `{rule}`; open only this rule on one date |
| DELETE /api/admin/recurring-blocks/:id/exceptions/:date | `{version}` | `{rule}`; restore this rule on one date, reject booking conflicts |
| GET /api/admin/audit?limit=... | admin | `{items:[{id,entity_type,entity_id,action,actor_name,created_at,before_data,after_data}]}` |
| GET /api/admin/export.csv?from=...&to=... | admin | CSV download |


## Additional boundary decisions

- Optional `request_id` on create is a UUID generated once per form submission; retry with the same request_id and identical authenticated owner/payload returns the original reservation, never another booking. Reuse with different payload returns conflict.
- Test/development adapter: export `createTestDatabase(filename=":memory:")` from `web/tests/sqlite-d1.mjs`; returns `{binding,sqlite,close}`. It tracks ordered schema migrations and upgrades an existing 0001 database without resetting records. `binding` implements D1, `sqlite` is the native DatabaseSync.
- Public UI can use `date`, `start_time`, `end_time` as strings. No minute integers leak into the API contract.
- Availability is shared by all approved members and the administrator. It includes every confirmed reservation and active operator block for the exact date, including telephone bookings; it never includes names, phone numbers, account/booking IDs, or private notes. Personal booking lists retain their existing ownership filter.
- Availability day status is `available|full|closed|unavailable`; slot status is `available|booked|blocked|past|full`. `available_count` is the number of selectable start times, not the remaining daily booking allowance. Occupied slots remain `booked` when the daily cap is reached. Cancelled bookings and deleted blocks reopen their slots, subject to the remaining rules.
- Calendar availability accepts a real `YYYY-MM` only and returns 28–31 summaries. It reads weekly rules, anonymous booking/block intervals, and applicable recurring rules/exceptions in bounded range queries rather than one query per day. Each response captures Seoul time once. The displayed state is informational; database constraints recheck overlap and capacity atomically at booking creation.
- Admin block DELETE means soft delete with acting user recorded.
- Bulk closure dates are inclusive, 1–31 days, between Seoul today and today + 365 days. `period` is `day` (00:00–24:00), `morning` (00:00–12:00), `afternoon` (12:00–24:00), or `custom` (explicit half-hour boundaries). Presets determine their own times. A confirmed reservation conflicting on any selected date rejects the whole batch; neither reservations nor an earlier subset of dates are changed. The database trigger still checks conflicts after the preview.
- Bulk `request_id` is an actor-and-payload-bound UUID. Identical retries return the surviving original rows. Reuse with another payload returns conflict, including concurrent attempts with disjoint date ranges. Soft-deleted rows retain request identity, so retry cannot resurrect a released group. Unlocking a group leaves independent groups, legacy single blocks and weekly closures intact. No schema migration is needed for bulk closure metadata.
- Recurring rules use `frequency: daily|weekly|biweekly|monthly`, inclusive `start_date` / optional `end_date`, half-hour `start_time` / `end_time` (24:00 accepted at the end), and an operator-only `note`. Weekly/biweekly use `weekdays` (0–6); biweekly counts Monday-start weeks from the start date's week. Monthly uses `monthly_mode: day|weekday` with `month_day` or `month_week` (1–5 or -1 for last) plus `month_weekday`. Dates missing from a month are skipped. Cross-midnight intervals require two rules.
- `RecurringBlock` additionally includes `id,enabled,version,exceptions` (ISO date strings). At most 32 nondeleted rules are retained. Exceptions remove only that rule for the date; independent locks and the normal opening rules still apply. Modifications use optimistic versions. Rule creation/edit/resume and restoring an exception reject overlapping future or ongoing confirmed reservations; ordinary booking writes are also protected by SQL triggers. No booking is automatically cancelled.
- The recurring schema is additive and installed transactionally on the first authorized modifying request. Completely absent schema means there are no recurring rules yet. A partially installed schema must not make customer availability or new booking writes succeed without its guards. The same additive statements are supplied in migration 0003; existing records and account configuration are preserved.
- Admin settings save includes the complete seven weekly rules and all six settings. Default settings: shop_name jinSling 예약; contact_phone empty; booking_window_days 30; cancel_before_minutes 0; member_limit 100; registration_open true. Member limit accepts 1–1,000, counts all stored accounts, and cannot be lowered below current count.
- New bookings/corrected slot must be strictly in the future. Customer memo edits/cancellations are allowed only before the start/cancel cutoff. Admin may correct or cancel historical records.

## Account security boundaries

- Username is 4–32 ASCII letters/digits/underscores, normalized to lowercase. Password is 12–128 Unicode code points; do not trim or normalize it. Password confirmation is a UI-only field.
- Approval is required once, not on each login. Pending users may log in and see their own status; approved members can reserve independently. Every protected request checks current status and credential revision.
- Legacy key sessions can only inspect their session, log out, and choose a password. Converted accounts never accept their old key.
- Reset tokens have 256 bits of randomness, expire after 24 hours, and are stored only as hashes. The UI consumes URL fragments immediately, including same-document navigation. Owner reset issuance blocks password login until completion.
- Provider password mutations are serialized with a non-expiring per-user lock; revision compare-and-swap prevents a delayed login from surviving reset/suspension. An uncertain provider or D1 outcome remains locked for owner recovery. Firebase and D1 are not a single transaction.
- Firebase UID is accepted only from the server's own fixed Google HTTPS response, never from a browser-supplied identity token. Provider errors expose static application messages only.
- CSV values are escaped against spreadsheet formula execution. Downloaded phone columns should be imported as text to preserve leading zeroes.
- `auth_ready` verifies configuration shape, not live connectivity, IAM permission, alias acceptance, or hosted CPU capacity. Test/dev injection is not an operating fallback.
- See [owner recovery](DEPLOY_FREE.md#계정-분실과-중단된-비밀번호-처리-복구) for partial provider/D1 failures, including unlinked provider accounts after an interrupted signup.
