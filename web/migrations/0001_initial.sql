-- Schema only. Bootstrap data is inserted by an explicit, authenticated transaction.
PRAGMA foreign_keys=ON;
CREATE TABLE settings (
 id INTEGER PRIMARY KEY CHECK(id=1), shop_name TEXT NOT NULL CHECK(length(shop_name) BETWEEN 1 AND 80),
 contact_phone TEXT NOT NULL DEFAULT '', booking_window_days INTEGER NOT NULL CHECK(booking_window_days BETWEEN 1 AND 90),
 cancel_before_minutes INTEGER NOT NULL CHECK(cancel_before_minutes BETWEEN 0 AND 10080),
 pilot_member_limit INTEGER NOT NULL CHECK(pilot_member_limit BETWEEN 1 AND 100), updated_by TEXT
);
CREATE TABLE weekly_rules (
 weekday INTEGER PRIMARY KEY CHECK(weekday BETWEEN 0 AND 6), closed INTEGER NOT NULL CHECK(closed IN(0,1)),
 open_time TEXT NOT NULL, close_time TEXT NOT NULL, open_min INTEGER NOT NULL, close_min INTEGER NOT NULL,
 daily_limit INTEGER NOT NULL CHECK(daily_limit BETWEEN 1 AND 48), updated_by TEXT,
 CHECK(open_min>=0 AND close_min<=1440 AND open_min<close_min AND open_min%30=0 AND close_min%30=0),
 CHECK(open_time=printf('%02d:%02d',open_min/60,open_min%60) AND close_time=printf('%02d:%02d',close_min/60,close_min%60))
);
CREATE TABLE invites (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT(datetime('now')),expires_at TEXT NOT NULL,used_at TEXT,used_by TEXT,revoked_at TEXT,created_by TEXT NOT NULL,revoked_by TEXT);
CREATE TABLE users (
 id TEXT PRIMARY KEY,name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),phone TEXT NOT NULL CHECK(length(phone) BETWEEN 8 AND 30),
 role TEXT NOT NULL CHECK(role IN('admin','user')), status TEXT NOT NULL CHECK(status IN('pending','approved','suspended','rejected')),
 key_hash TEXT NOT NULL UNIQUE,invite_id TEXT UNIQUE REFERENCES invites(id),created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_by TEXT,
 CHECK(role!='admin' OR status='approved')
);
CREATE UNIQUE INDEX one_administrator ON users(role) WHERE role='admin';
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE rate_limits (bucket TEXT PRIMARY KEY,window INTEGER NOT NULL,attempts INTEGER NOT NULL);
CREATE TABLE bookings (
 id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),customer_name TEXT NOT NULL CHECK(length(customer_name) BETWEEN 1 AND 80),phone TEXT NOT NULL CHECK(length(phone) BETWEEN 8 AND 30),
 date TEXT NOT NULL CHECK(length(date)=10 AND date(date,'+0 days') IS NOT NULL AND date(date,'+0 days')=date),
 start_min INTEGER NOT NULL CHECK(start_min>=0 AND start_min%30=0),end_min INTEGER NOT NULL CHECK(end_min=start_min+30 AND end_min<=1440),
 start_time TEXT NOT NULL,end_time TEXT NOT NULL,memo TEXT NOT NULL DEFAULT '' CHECK(length(memo)<=1000),
 status TEXT NOT NULL CHECK(status IN('confirmed','cancelled')),version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')),updated_by TEXT NOT NULL REFERENCES users(id),cancel_reason TEXT NOT NULL DEFAULT '',
 request_id TEXT,request_actor TEXT REFERENCES users(id),request_payload TEXT,
 CHECK(start_time=printf('%02d:%02d',start_min/60,start_min%60) AND end_time=printf('%02d:%02d',end_min/60,end_min%60)),
 UNIQUE(request_actor,request_id)
);
CREATE INDEX bookings_date ON bookings(date,status,start_min);
CREATE INDEX bookings_owner ON bookings(user_id,date);
CREATE TABLE blocks (
 id TEXT PRIMARY KEY,date TEXT NOT NULL CHECK(length(date)=10 AND date(date,'+0 days') IS NOT NULL AND date(date,'+0 days')=date),
 start_time TEXT NOT NULL,end_time TEXT NOT NULL,start_min INTEGER NOT NULL,end_min INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=500),
 created_at TEXT NOT NULL DEFAULT(datetime('now')),created_by TEXT NOT NULL REFERENCES users(id),deleted_at TEXT,deleted_by TEXT REFERENCES users(id),
 CHECK(start_min>=0 AND end_min<=1440 AND start_min<end_min AND start_min%30=0 AND end_min%30=0),
 CHECK(start_time=printf('%02d:%02d',start_min/60,start_min%60) AND end_time=printf('%02d:%02d',end_min/60,end_min%60))
);
CREATE INDEX blocks_date ON blocks(date,deleted_at);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,action TEXT NOT NULL,actor_name TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),before_data TEXT,after_data TEXT);

CREATE TRIGGER users_insert_guard BEFORE INSERT ON users BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM users)>=(SELECT pilot_member_limit FROM settings WHERE id=1) THEN RAISE(ABORT,'member_limit') END;
 SELECT CASE WHEN NEW.role='user' AND NOT EXISTS(SELECT 1 FROM invites WHERE id=NEW.invite_id AND used_at IS NULL AND revoked_at IS NULL AND expires_at>datetime('now')) THEN RAISE(ABORT,'invalid_invite') END;
END;
CREATE TRIGGER consume_invite AFTER INSERT ON users WHEN NEW.invite_id IS NOT NULL BEGIN
 UPDATE invites SET used_at=datetime('now'),used_by=NEW.id WHERE id=NEW.invite_id;
END;
CREATE TRIGGER users_revoke_sessions AFTER UPDATE OF status,key_hash ON users WHEN NEW.key_hash!=OLD.key_hash OR NEW.status IN('suspended','rejected') BEGIN
 DELETE FROM sessions WHERE user_id=NEW.id;
END;
CREATE TRIGGER settings_guard BEFORE UPDATE ON settings BEGIN
 SELECT CASE WHEN NEW.pilot_member_limit<(SELECT count(*) FROM users) THEN RAISE(ABORT,'member_limit') END;
END;
CREATE TRIGGER weekly_rule_guard BEFORE UPDATE ON weekly_rules BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM bookings b WHERE b.status='confirmed' AND b.date||' '||b.start_time>strftime('%Y-%m-%d %H:%M','now','+9 hours') AND cast(strftime('%w',b.date) AS INTEGER)=NEW.weekday AND (NEW.closed=1 OR b.start_min<NEW.open_min OR b.end_min>NEW.close_min)) THEN RAISE(ABORT,'rule_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT date FROM bookings WHERE status='confirmed' AND date>=date('now','+9 hours') AND cast(strftime('%w',date) AS INTEGER)=NEW.weekday GROUP BY date HAVING count(*)>NEW.daily_limit) THEN RAISE(ABORT,'rule_conflict') END;
END;
CREATE TRIGGER block_guard BEFORE INSERT ON blocks BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM bookings WHERE status='confirmed' AND date=NEW.date AND start_min<NEW.end_min AND end_min>NEW.start_min) THEN RAISE(ABORT,'block_conflict') END;
END;
CREATE TRIGGER booking_version BEFORE UPDATE ON bookings BEGIN
 SELECT CASE WHEN NEW.version!=OLD.version+1 THEN RAISE(ABORT,'stale_version') END;
 SELECT CASE WHEN NEW.id!=OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.created_at!=OLD.created_at OR NEW.request_id IS NOT OLD.request_id OR NEW.request_actor IS NOT OLD.request_actor OR NEW.request_payload IS NOT OLD.request_payload THEN RAISE(ABORT,'immutable_booking') END;
END;

CREATE TRIGGER booking_guard_insert BEFORE INSERT ON bookings WHEN NEW.status='confirmed' BEGIN
 SELECT CASE WHEN NEW.date||' '||NEW.start_time<=strftime('%Y-%m-%d %H:%M','now','+9 hours') OR NEW.date>date('now','+9 hours','+'||(SELECT booking_window_days FROM settings WHERE id=1)||' days') THEN RAISE(ABORT,'outside_window') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM weekly_rules WHERE weekday=cast(strftime('%w',NEW.date) AS INTEGER) AND closed=0 AND NEW.start_min>=open_min AND NEW.end_min<=close_min) THEN RAISE(ABORT,'closed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM bookings WHERE status='confirmed' AND id!=NEW.id AND date=NEW.date AND start_min<NEW.end_min AND end_min>NEW.start_min) THEN RAISE(ABORT,'slot_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM blocks WHERE deleted_at IS NULL AND date=NEW.date AND start_min<NEW.end_min AND end_min>NEW.start_min) THEN RAISE(ABORT,'block_conflict') END;
 SELECT CASE WHEN (SELECT count(*) FROM bookings WHERE status='confirmed' AND date=NEW.date AND id!=NEW.id)>=(SELECT daily_limit FROM weekly_rules WHERE weekday=cast(strftime('%w',NEW.date) AS INTEGER)) THEN RAISE(ABORT,'daily_limit') END;
END;

CREATE TRIGGER booking_guard_update BEFORE UPDATE ON bookings WHEN NEW.status='confirmed' AND (OLD.status!='confirmed' OR NEW.date!=OLD.date OR NEW.start_min!=OLD.start_min) BEGIN
 SELECT CASE WHEN NEW.date||' '||NEW.start_time<=strftime('%Y-%m-%d %H:%M','now','+9 hours') OR NEW.date>date('now','+9 hours','+'||(SELECT booking_window_days FROM settings WHERE id=1)||' days') THEN RAISE(ABORT,'outside_window') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM weekly_rules WHERE weekday=cast(strftime('%w',NEW.date) AS INTEGER) AND closed=0 AND NEW.start_min>=open_min AND NEW.end_min<=close_min) THEN RAISE(ABORT,'closed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM bookings WHERE status='confirmed' AND id!=NEW.id AND date=NEW.date AND start_min<NEW.end_min AND end_min>NEW.start_min) THEN RAISE(ABORT,'slot_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM blocks WHERE deleted_at IS NULL AND date=NEW.date AND start_min<NEW.end_min AND end_min>NEW.start_min) THEN RAISE(ABORT,'block_conflict') END;
 SELECT CASE WHEN (SELECT count(*) FROM bookings WHERE status='confirmed' AND date=NEW.date AND id!=NEW.id)>=(SELECT daily_limit FROM weekly_rules WHERE weekday=cast(strftime('%w',NEW.date) AS INTEGER)) THEN RAISE(ABORT,'daily_limit') END;
END;

CREATE TRIGGER audit_bookings_insert AFTER INSERT ON bookings BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('booking',NEW.id,'create',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),'system'),NULL,json_object('id',NEW.id,'user_id',NEW.user_id,'customer_name',NEW.customer_name,'phone',NEW.phone,'date',NEW.date,'start_time',NEW.start_time,'end_time',NEW.end_time,'memo',NEW.memo,'status',NEW.status,'version',NEW.version,'cancel_reason',NEW.cancel_reason));
END;

CREATE TRIGGER audit_bookings_update AFTER UPDATE ON bookings BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('booking',NEW.id,'update',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),'system'),json_object('id',OLD.id,'user_id',OLD.user_id,'customer_name',OLD.customer_name,'phone',OLD.phone,'date',OLD.date,'start_time',OLD.start_time,'end_time',OLD.end_time,'memo',OLD.memo,'status',OLD.status,'version',OLD.version,'cancel_reason',OLD.cancel_reason),json_object('id',NEW.id,'user_id',NEW.user_id,'customer_name',NEW.customer_name,'phone',NEW.phone,'date',NEW.date,'start_time',NEW.start_time,'end_time',NEW.end_time,'memo',NEW.memo,'status',NEW.status,'version',NEW.version,'cancel_reason',NEW.cancel_reason));
END;

CREATE TRIGGER audit_users_insert AFTER INSERT ON users BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('user',NEW.id,'create',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),NEW.name),NULL,json_object('id',NEW.id,'name',NEW.name,'phone',NEW.phone,'role',NEW.role,'status',NEW.status));
END;

CREATE TRIGGER audit_users_update AFTER UPDATE ON users BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('user',NEW.id,'update',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),NEW.name),json_object('id',OLD.id,'name',OLD.name,'phone',OLD.phone,'role',OLD.role,'status',OLD.status),json_object('id',NEW.id,'name',NEW.name,'phone',NEW.phone,'role',NEW.role,'status',NEW.status));
END;

CREATE TRIGGER audit_invites_insert AFTER INSERT ON invites BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('invite',NEW.id,'create',coalesce((SELECT name FROM users WHERE id=NEW.created_by),'system'),NULL,json_object('id',NEW.id,'created_at',NEW.created_at,'expires_at',NEW.expires_at,'used_at',NEW.used_at,'revoked_at',NEW.revoked_at));
END;

CREATE TRIGGER audit_invites_update AFTER UPDATE ON invites BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('invite',NEW.id,'update',coalesce((SELECT name FROM users WHERE id=coalesce(NEW.revoked_by,NEW.used_by,NEW.created_by)),'system'),json_object('id',OLD.id,'created_at',OLD.created_at,'expires_at',OLD.expires_at,'used_at',OLD.used_at,'revoked_at',OLD.revoked_at),json_object('id',NEW.id,'created_at',NEW.created_at,'expires_at',NEW.expires_at,'used_at',NEW.used_at,'revoked_at',NEW.revoked_at));
END;

CREATE TRIGGER audit_blocks_insert AFTER INSERT ON blocks BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('block',NEW.id,'create',coalesce((SELECT name FROM users WHERE id=NEW.created_by),'system'),NULL,json_object('id',NEW.id,'date',NEW.date,'start_time',NEW.start_time,'end_time',NEW.end_time,'note',NEW.note,'deleted_at',NEW.deleted_at));
END;

CREATE TRIGGER audit_blocks_update AFTER UPDATE ON blocks BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('block',NEW.id,'update',coalesce((SELECT name FROM users WHERE id=coalesce(NEW.deleted_by,NEW.created_by)),'system'),json_object('id',OLD.id,'date',OLD.date,'start_time',OLD.start_time,'end_time',OLD.end_time,'note',OLD.note,'deleted_at',OLD.deleted_at),json_object('id',NEW.id,'date',NEW.date,'start_time',NEW.start_time,'end_time',NEW.end_time,'note',NEW.note,'deleted_at',NEW.deleted_at));
END;

CREATE TRIGGER audit_settings_insert AFTER INSERT ON settings BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('settings',NEW.id,'create',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),'system'),NULL,json_object('shop_name',NEW.shop_name,'contact_phone',NEW.contact_phone,'booking_window_days',NEW.booking_window_days,'cancel_before_minutes',NEW.cancel_before_minutes,'pilot_member_limit',NEW.pilot_member_limit));
END;

CREATE TRIGGER audit_settings_update AFTER UPDATE ON settings BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('settings',NEW.id,'update',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),'system'),json_object('shop_name',OLD.shop_name,'contact_phone',OLD.contact_phone,'booking_window_days',OLD.booking_window_days,'cancel_before_minutes',OLD.cancel_before_minutes,'pilot_member_limit',OLD.pilot_member_limit),json_object('shop_name',NEW.shop_name,'contact_phone',NEW.contact_phone,'booking_window_days',NEW.booking_window_days,'cancel_before_minutes',NEW.cancel_before_minutes,'pilot_member_limit',NEW.pilot_member_limit));
END;

CREATE TRIGGER audit_weekly_rules_insert AFTER INSERT ON weekly_rules BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('weekly_rule',NEW.weekday,'create',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),'system'),NULL,json_object('weekday',NEW.weekday,'closed',NEW.closed,'open_time',NEW.open_time,'close_time',NEW.close_time,'daily_limit',NEW.daily_limit));
END;

CREATE TRIGGER audit_weekly_rules_update AFTER UPDATE ON weekly_rules BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('weekly_rule',NEW.weekday,'update',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),'system'),json_object('weekday',OLD.weekday,'closed',OLD.closed,'open_time',OLD.open_time,'close_time',OLD.close_time,'daily_limit',OLD.daily_limit),json_object('weekday',NEW.weekday,'closed',NEW.closed,'open_time',NEW.open_time,'close_time',NEW.close_time,'daily_limit',NEW.daily_limit));
END;
