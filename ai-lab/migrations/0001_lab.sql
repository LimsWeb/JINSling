-- AI lab only. Apply to a NEW, dedicated database, never the operational app.
CREATE TABLE lab_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO lab_meta (key, value) VALUES ('stage', 'sandbox'), ('schema_version', '1');

CREATE TABLE lab_users (
  id TEXT PRIMARY KEY CHECK (id IN ('owner', 'member_a', 'member_b', 'pending')),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  status TEXT NOT NULL CHECK (status IN ('approved', 'pending', 'suspended')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK ((id = 'owner' AND role = 'owner' AND status = 'approved') OR (id <> 'owner' AND role = 'member'))
);
INSERT INTO lab_users (id, name, role, status) VALUES
  ('owner', '가상사장님', 'owner', 'approved'),
  ('member_a', '가상회원 A', 'member', 'approved'),
  ('member_b', '가상회원 B', 'member', 'approved'),
  ('pending', '가상대기회원', 'member', 'pending');

CREATE TABLE lab_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id TEXT NOT NULL REFERENCES lab_users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX lab_sessions_expiry ON lab_sessions (expires_at);

CREATE TABLE lab_bookings (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES lab_users(id),
  date TEXT NOT NULL CHECK (length(date) = 10 AND date(date, '+0 days') IS NOT NULL AND date(date, '+0 days') = date AND strftime('%w', date) <> '0'),
  start_time TEXT NOT NULL CHECK (length(start_time) = 5 AND substr(start_time, 4, 2) IN ('00', '30') AND start_time >= '09:00'),
  end_time TEXT NOT NULL CHECK (end_time = substr(time(start_time, '+30 minutes'), 1, 5) AND end_time <= CASE strftime('%w', date) WHEN '6' THEN '14:00' ELSE '20:00' END),
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES lab_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX lab_bookings_member_date ON lab_bookings (member_id, date);
CREATE INDEX lab_bookings_date_status ON lab_bookings (date, status);
CREATE UNIQUE INDEX lab_bookings_one_slot ON lab_bookings (date, start_time) WHERE status = 'booked';

CREATE TABLE lab_blocks (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL CHECK (length(date) = 10 AND date(date, '+0 days') IS NOT NULL AND date(date, '+0 days') = date),
  period TEXT NOT NULL CHECK (period IN ('day', 'morning', 'afternoon')),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES lab_users(id),
  created_at INTEGER NOT NULL,
  CHECK ((period = 'day' AND start_time = '00:00' AND end_time = '24:00')
      OR (period = 'morning' AND start_time = '00:00' AND end_time = '12:00')
      OR (period = 'afternoon' AND start_time = '12:00' AND end_time = '24:00'))
);
CREATE INDEX lab_blocks_date ON lab_blocks (date);

CREATE TABLE lab_proposals (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES lab_users(id),
  action TEXT NOT NULL CHECK (action IN ('book', 'cancel', 'block', 'unblock', 'member_status')),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  expected_json TEXT NOT NULL CHECK (json_valid(expected_json)),
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'executing', 'confirmed')),
  execution_id TEXT,
  confirmed_at INTEGER,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))
);
CREATE INDEX lab_proposals_actor ON lab_proposals (actor_id, expires_at);

CREATE TABLE lab_audit (
  proposal_id TEXT PRIMARY KEY REFERENCES lab_proposals(id),
  actor_id TEXT NOT NULL REFERENCES lab_users(id),
  action TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at INTEGER NOT NULL
);

-- The claim, action, audit and result are committed in ONE D1 batch transaction.
-- Rechecking these invariants inside SQLite closes the gap after HTTP prechecks.
CREATE TRIGGER lab_proposal_execute_guard BEFORE UPDATE OF state ON lab_proposals
WHEN NEW.state = 'executing'
BEGIN
  SELECT CASE WHEN OLD.state <> 'pending' OR NEW.execution_id IS NULL THEN RAISE(ABORT, 'LAB_STALE_PROPOSAL') END;
  SELECT CASE WHEN NEW.confirmed_at IS NULL OR NEW.expires_at <= NEW.confirmed_at THEN RAISE(ABORT, 'LAB_PROPOSAL_EXPIRED') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM lab_users WHERE id = NEW.actor_id AND status = 'approved'
      AND version = json_extract(NEW.expected_json, '$.actor_version')
  ) THEN RAISE(ABORT, 'LAB_STALE_PROPOSAL') END;
  SELECT CASE WHEN NEW.action IN ('block', 'unblock', 'member_status') AND NOT EXISTS (
    SELECT 1 FROM lab_users WHERE id = NEW.actor_id AND role = 'owner'
  ) THEN RAISE(ABORT, 'LAB_FORBIDDEN') END;
  SELECT CASE WHEN NEW.action = 'book' AND NOT EXISTS (
    SELECT 1 FROM lab_users WHERE id = json_extract(NEW.data_json, '$.member_id')
      AND role = 'member' AND status = 'approved' AND version = json_extract(NEW.expected_json, '$.member_version')
  ) THEN RAISE(ABORT, 'LAB_STALE_PROPOSAL') END;
  SELECT CASE WHEN NEW.action = 'book' AND NEW.actor_id <> json_extract(NEW.data_json, '$.member_id') AND NOT EXISTS (
    SELECT 1 FROM lab_users WHERE id = NEW.actor_id AND role = 'owner'
  ) THEN RAISE(ABORT, 'LAB_FORBIDDEN') END;
  SELECT CASE WHEN NEW.action = 'cancel' AND NOT EXISTS (
    SELECT 1 FROM lab_bookings b WHERE b.id = json_extract(NEW.data_json, '$.booking_id')
      AND b.status = 'booked' AND b.version = json_extract(NEW.expected_json, '$.booking_version')
      AND (b.member_id = NEW.actor_id OR EXISTS (SELECT 1 FROM lab_users WHERE id = NEW.actor_id AND role = 'owner'))
      AND CAST(strftime('%s', b.date || 'T' || b.start_time || ':00+09:00') AS INTEGER) * 1000 > NEW.confirmed_at
  ) THEN RAISE(ABORT, 'LAB_STALE_PROPOSAL') END;
  SELECT CASE WHEN NEW.action = 'unblock' AND NOT EXISTS (
    SELECT 1 FROM lab_blocks WHERE id = json_extract(NEW.data_json, '$.block_id')
      AND version = json_extract(NEW.expected_json, '$.block_version')
  ) THEN RAISE(ABORT, 'LAB_STALE_PROPOSAL') END;
  SELECT CASE WHEN NEW.action = 'member_status' AND NOT EXISTS (
    SELECT 1 FROM lab_users WHERE id = json_extract(NEW.data_json, '$.member_id')
      AND role = 'member' AND version = json_extract(NEW.expected_json, '$.member_version')
  ) THEN RAISE(ABORT, 'LAB_STALE_PROPOSAL') END;
END;

CREATE TRIGGER lab_booking_insert_guard BEFORE INSERT ON lab_bookings
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM lab_users WHERE id = NEW.member_id AND role = 'member' AND status = 'approved')
    THEN RAISE(ABORT, 'LAB_MEMBER_NOT_APPROVED') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM lab_users WHERE id = NEW.created_by AND status = 'approved' AND (role = 'owner' OR id = NEW.member_id))
    THEN RAISE(ABORT, 'LAB_FORBIDDEN') END;
  SELECT CASE WHEN NEW.status <> 'booked' OR CAST(strftime('%s', NEW.date || 'T' || NEW.start_time || ':00+09:00') AS INTEGER) * 1000 <= NEW.created_at
    OR NEW.date < date(NEW.created_at / 1000, 'unixepoch', '+9 hours')
    OR NEW.date > date(NEW.created_at / 1000, 'unixepoch', '+9 hours', '+30 days')
    THEN RAISE(ABORT, 'LAB_BOOKING_UNAVAILABLE') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM lab_blocks WHERE date = NEW.date AND start_time < NEW.end_time AND end_time > NEW.start_time)
    THEN RAISE(ABORT, 'LAB_BOOKING_UNAVAILABLE') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM lab_bookings WHERE date = NEW.date AND status = 'booked' AND start_time < NEW.end_time AND end_time > NEW.start_time)
    THEN RAISE(ABORT, 'LAB_BOOKING_UNAVAILABLE') END;
  SELECT CASE WHEN (SELECT count(*) FROM lab_bookings WHERE date = NEW.date AND status = 'booked') >= CASE strftime('%w', NEW.date) WHEN '6' THEN 10 ELSE 18 END
    THEN RAISE(ABORT, 'LAB_BOOKING_UNAVAILABLE') END;
END;

CREATE TRIGGER lab_booking_update_guard BEFORE UPDATE ON lab_bookings
WHEN NEW.member_id <> OLD.member_id OR NEW.date <> OLD.date OR NEW.start_time <> OLD.start_time
  OR NEW.end_time <> OLD.end_time OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
  OR NEW.version <> OLD.version + 1 OR OLD.status <> 'booked' OR NEW.status <> 'cancelled'
BEGIN SELECT RAISE(ABORT, 'LAB_STALE_PROPOSAL'); END;

CREATE TRIGGER lab_block_insert_guard BEFORE INSERT ON lab_blocks
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM lab_users WHERE id = NEW.created_by AND role = 'owner' AND status = 'approved')
    THEN RAISE(ABORT, 'LAB_FORBIDDEN') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM lab_bookings WHERE date = NEW.date AND status = 'booked' AND start_time < NEW.end_time AND end_time > NEW.start_time)
    THEN RAISE(ABORT, 'LAB_BLOCK_CONFLICT') END;
END;

CREATE TABLE lab_ai_usage (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL CHECK (user_id IN ('*', 'owner', 'member_a', 'member_b', 'pending')),
  used INTEGER NOT NULL CHECK (used >= 0),
  PRIMARY KEY (day, user_id)
);
CREATE TRIGGER lab_ai_usage_insert_guard BEFORE INSERT ON lab_ai_usage
WHEN NEW.used > CASE WHEN NEW.user_id = '*' THEN 30 ELSE 10 END
BEGIN SELECT RAISE(ABORT, 'LAB_AI_BUDGET'); END;
CREATE TRIGGER lab_ai_usage_update_guard BEFORE UPDATE OF used ON lab_ai_usage
WHEN NEW.used > CASE WHEN NEW.user_id = '*' THEN 30 ELSE 10 END
BEGIN SELECT RAISE(ABORT, 'LAB_AI_BUDGET'); END;
