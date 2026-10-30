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
| GET /api/availability?date=... | approved user | `{date,slots:[{start_time,end_time,available}],booked_count,daily_limit,closed,reason}` |
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
| GET /api/admin/blocks?from=...&to=... | admin | `{items:[{id,date,start_time,end_time,note}]}` |
| POST /api/admin/blocks | `{date,start_time,end_time,note}` | `{block}`; reject confirmed-booking conflicts |
| DELETE /api/admin/blocks/:id | `{}` | `{}` |
| GET /api/admin/audit?limit=... | admin | `{items:[{id,entity_type,entity_id,action,actor_name,created_at,before_data,after_data}]}` |
| GET /api/admin/export.csv?from=...&to=... | admin | CSV download |


## Additional boundary decisions

- Optional `request_id` on create is a UUID generated once per form submission; retry with the same request_id and identical authenticated owner/payload returns the original reservation, never another booking. Reuse with different payload returns conflict.
- Test/development adapter: export `createTestDatabase(filename=":memory:")` from `web/tests/sqlite-d1.mjs`; returns `{binding,sqlite,close}`. It tracks ordered schema migrations and upgrades an existing 0001 database without resetting records. `binding` implements D1, `sqlite` is the native DatabaseSync.
- Public UI can use `date`, `start_time`, `end_time` as strings. No minute integers leak into the API contract.
- Admin block DELETE means soft delete with acting user recorded.
- Admin settings save includes the complete seven weekly rules and all six settings. Default settings: shop_name jinSling 예약; contact_phone empty; booking_window_days 30; cancel_before_minutes 0; member_limit 100; registration_open true. Member limit accepts 1–1,000, counts all stored accounts, and cannot be lowered below current count.
- New bookings/corrected slot must be strictly in the future. Customer memo edits/cancellations are allowed only before the start/cancel cutoff. Admin may correct or cancel historical records.

## Account security boundaries

- Username is 4–32 ASCII letters/digits/underscores, normalized to lowercase. Password is 15–128 Unicode code points; do not trim or normalize it. Password confirmation is a UI-only field.
- Approval is required once, not on each login. Pending users may log in and see their own status; approved members can reserve independently. Every protected request checks current status and credential revision.
- Legacy key sessions can only inspect their session, log out, and choose a password. Converted accounts never accept their old key.
- Reset tokens have 256 bits of randomness, expire after 24 hours, and are stored only as hashes. The UI consumes URL fragments immediately, including same-document navigation. Owner reset issuance blocks password login until completion.
- Provider password mutations are serialized with a non-expiring per-user lock; revision compare-and-swap prevents a delayed login from surviving reset/suspension. An uncertain provider or D1 outcome remains locked for owner recovery. Firebase and D1 are not a single transaction.
- Firebase UID is accepted only from the server's own fixed Google HTTPS response, never from a browser-supplied identity token. Provider errors expose static application messages only.
- CSV values are escaped against spreadsheet formula execution. Downloaded phone columns should be imported as text to preserve leading zeroes.
- `auth_ready` verifies configuration shape, not live connectivity, IAM permission, alias acceptance, or hosted CPU capacity. Test/dev injection is not an operating fallback.
- See [owner recovery](DEPLOY_FREE.md#계정-분실과-중단된-비밀번호-처리-복구) for partial provider/D1 failures, including unlinked provider accounts after an interrupted signup.
