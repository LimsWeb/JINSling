// One predicate is used for both sides of each database conflict check. Aliases
// and date expressions come only from this module/server code, never user input.
export function recurrenceMatchSql(rule,date){
 const weekday=`CAST(strftime('%w',${date}) AS INTEGER)`,day=`CAST(strftime('%d',${date}) AS INTEGER)`;
 const anchorOffset=`((CAST(strftime('%w',${rule}.start_date) AS INTEGER)+6)%7)`;
 const alternating=`((CAST(julianday(${date})-julianday(${rule}.start_date) AS INTEGER)+${anchorOffset})/7)%2=0`;
 return `(${date}>=${rule}.start_date AND (${rule}.end_date IS NULL OR ${date}<=${rule}.end_date) AND (
 ${rule}.frequency='daily'
 OR (${rule}.frequency IN ('weekly','biweekly') AND (${rule}.weekdays_mask & (1 << ${weekday}))!=0 AND (${rule}.frequency='weekly' OR (${alternating})))
 OR (${rule}.frequency='monthly' AND (
  (${rule}.monthly_mode='day' AND ${day}=${rule}.month_day)
  OR (${rule}.monthly_mode='weekday' AND ${weekday}=${rule}.month_weekday AND (
   (${rule}.month_week BETWEEN 1 AND 5 AND ((${day}-1)/7)+1=${rule}.month_week)
   OR (${rule}.month_week=-1 AND strftime('%m',${date},'+7 days') IS NOT strftime('%m',${date}))
  ))
 ))))`;
}

const liveBooking=`b.status='confirmed' AND b.date||' '||b.end_time>strftime('%Y-%m-%d %H:%M','now','+9 hours')`;
const ruleConflict=`EXISTS(SELECT 1 FROM bookings b WHERE ${liveBooking}
 AND b.start_min<NEW.end_min AND b.end_min>NEW.start_min AND ${recurrenceMatchSql('NEW','b.date')}
 AND NOT EXISTS(SELECT 1 FROM recurring_block_exceptions x WHERE x.rule_id=NEW.id AND x.date=b.date AND x.active=1))`;
const bookingConflict=`EXISTS(SELECT 1 FROM recurring_blocks r WHERE r.enabled=1 AND r.deleted_at IS NULL
 AND r.start_min<NEW.end_min AND r.end_min>NEW.start_min AND ${recurrenceMatchSql('r','NEW.date')}
 AND NOT EXISTS(SELECT 1 FROM recurring_block_exceptions x WHERE x.rule_id=r.id AND x.date=NEW.date AND x.active=1))`;
const ruleSnapshot=alias=>`json_object(${['id','frequency','start_date','end_date','weekdays_mask','monthly_mode','month_day','month_week','month_weekday','start_time','end_time','note','enabled','version','deleted_at'].map(key=>`'${key}',${alias}.${key}`).join(',')})`;
const exceptionSnapshot=alias=>`json_object('rule_id',${alias}.rule_id,'date',${alias}.date,'active',${alias}.active)`;
const exceptionConflict=alias=>`EXISTS(SELECT 1 FROM recurring_blocks r JOIN bookings b ON b.date=${alias}.date
 WHERE r.id=${alias}.rule_id AND r.enabled=1 AND r.deleted_at IS NULL AND ${liveBooking}
 AND b.start_min<r.end_min AND b.end_min>r.start_min AND ${recurrenceMatchSql('r','b.date')})`;

export const RECURRENCE_SCHEMA = [
 `CREATE TABLE IF NOT EXISTS recurring_blocks (
 id TEXT PRIMARY KEY,frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly','biweekly','monthly')),
 start_date TEXT NOT NULL CHECK(length(start_date)=10 AND date(start_date,'+0 days') IS NOT NULL AND date(start_date,'+0 days')=start_date),
 end_date TEXT CHECK(end_date IS NULL OR (length(end_date)=10 AND date(end_date,'+0 days') IS NOT NULL AND date(end_date,'+0 days')=end_date AND end_date>=start_date)),
 weekdays_mask INTEGER NOT NULL DEFAULT 0 CHECK(weekdays_mask BETWEEN 0 AND 127),
 monthly_mode TEXT,month_day INTEGER,month_week INTEGER,month_weekday INTEGER,
 start_time TEXT NOT NULL,end_time TEXT NOT NULL,start_min INTEGER NOT NULL,end_min INTEGER NOT NULL,
 note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=500),enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')),
 created_by TEXT NOT NULL REFERENCES users(id),updated_by TEXT NOT NULL REFERENCES users(id),deleted_at TEXT,
 request_id TEXT NOT NULL UNIQUE,request_payload TEXT NOT NULL,
 CHECK(start_min>=0 AND end_min<=1440 AND start_min<end_min AND start_min%30=0 AND end_min%30=0),
 CHECK(start_time=printf('%02d:%02d',start_min/60,start_min%60) AND end_time=printf('%02d:%02d',end_min/60,end_min%60)),
 CHECK((frequency='daily' AND weekdays_mask=0 AND monthly_mode IS NULL AND month_day IS NULL AND month_week IS NULL AND month_weekday IS NULL)
 OR (frequency IN ('weekly','biweekly') AND weekdays_mask BETWEEN 1 AND 127 AND monthly_mode IS NULL AND month_day IS NULL AND month_week IS NULL AND month_weekday IS NULL)
 OR (frequency='monthly' AND weekdays_mask=0 AND monthly_mode IS NOT NULL AND (
  (monthly_mode='day' AND month_day IS NOT NULL AND month_day BETWEEN 1 AND 31 AND month_week IS NULL AND month_weekday IS NULL)
  OR (monthly_mode='weekday' AND month_day IS NULL AND month_week IS NOT NULL AND month_week IN (-1,1,2,3,4,5) AND month_weekday IS NOT NULL AND month_weekday BETWEEN 0 AND 6)
 )))
 )`,
 `CREATE INDEX IF NOT EXISTS recurring_blocks_active ON recurring_blocks(deleted_at,enabled,start_date,end_date)`,
 `CREATE TABLE IF NOT EXISTS recurring_block_exceptions (
 rule_id TEXT NOT NULL REFERENCES recurring_blocks(id),date TEXT NOT NULL CHECK(length(date)=10 AND date(date,'+0 days') IS NOT NULL AND date(date,'+0 days')=date),
 active INTEGER NOT NULL CHECK(active IN (0,1)),rule_version INTEGER NOT NULL CHECK(rule_version>=1),
 created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')),updated_by TEXT NOT NULL REFERENCES users(id),
 PRIMARY KEY(rule_id,date)
 )`,
 `CREATE INDEX IF NOT EXISTS recurring_exceptions_date ON recurring_block_exceptions(date,active,rule_id)`,
 `CREATE TRIGGER IF NOT EXISTS recurring_insert_guard BEFORE INSERT ON recurring_blocks BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM recurring_blocks WHERE deleted_at IS NULL)>=32 THEN RAISE(ABORT,'recurring_limit') END;
 SELECT CASE WHEN NEW.enabled=1 AND NEW.deleted_at IS NULL AND ${ruleConflict} THEN RAISE(ABORT,'recurring_conflict') END;
 END`,
 `CREATE TRIGGER IF NOT EXISTS recurring_update_guard BEFORE UPDATE ON recurring_blocks BEGIN
 SELECT CASE WHEN NEW.version!=OLD.version+1 THEN RAISE(ABORT,'stale_version') END;
 SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR NEW.created_by IS NOT OLD.created_by OR NEW.request_id IS NOT OLD.request_id OR NEW.request_payload IS NOT OLD.request_payload OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at) THEN RAISE(ABORT,'immutable_recurring_rule') END;
 SELECT CASE WHEN NEW.enabled=1 AND NEW.deleted_at IS NULL AND ${ruleConflict} THEN RAISE(ABORT,'recurring_conflict') END;
 END`,
 `CREATE TRIGGER IF NOT EXISTS recurring_booking_guard_insert BEFORE INSERT ON bookings WHEN NEW.status='confirmed' BEGIN
 SELECT CASE WHEN ${bookingConflict} THEN RAISE(ABORT,'recurring_conflict') END;
 END`,
 `CREATE TRIGGER IF NOT EXISTS recurring_booking_guard_update BEFORE UPDATE ON bookings
 WHEN NEW.status='confirmed' AND (OLD.status!='confirmed' OR NEW.date!=OLD.date OR NEW.start_min!=OLD.start_min) BEGIN
 SELECT CASE WHEN ${bookingConflict} THEN RAISE(ABORT,'recurring_conflict') END;
 END`,
 `CREATE TRIGGER IF NOT EXISTS recurring_exception_insert_guard BEFORE INSERT ON recurring_block_exceptions BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM recurring_blocks r WHERE r.id=NEW.rule_id AND r.deleted_at IS NULL AND r.version=NEW.rule_version) THEN RAISE(ABORT,'stale_version') END;
 SELECT CASE WHEN NEW.active=1 AND NOT EXISTS(SELECT 1 FROM recurring_blocks r WHERE r.id=NEW.rule_id AND ${recurrenceMatchSql('r','NEW.date')}) THEN RAISE(ABORT,'recurring_exception_date') END;
 END`,
 `CREATE TRIGGER IF NOT EXISTS recurring_exception_update_guard BEFORE UPDATE ON recurring_block_exceptions BEGIN
 SELECT CASE WHEN NEW.rule_id IS NOT OLD.rule_id OR NEW.date IS NOT OLD.date OR NEW.created_at IS NOT OLD.created_at THEN RAISE(ABORT,'immutable_recurring_exception') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM recurring_blocks r WHERE r.id=NEW.rule_id AND r.deleted_at IS NULL AND r.version=NEW.rule_version) THEN RAISE(ABORT,'stale_version') END;
 SELECT CASE WHEN NEW.active=1 AND OLD.active=0 AND NOT EXISTS(SELECT 1 FROM recurring_blocks r WHERE r.id=NEW.rule_id AND ${recurrenceMatchSql('r','NEW.date')}) THEN RAISE(ABORT,'recurring_exception_date') END;
 SELECT CASE WHEN OLD.active=1 AND NEW.active=0 AND ${exceptionConflict('NEW')} THEN RAISE(ABORT,'recurring_conflict') END;
 END`,
 `CREATE TRIGGER IF NOT EXISTS recurring_exception_delete_guard BEFORE DELETE ON recurring_block_exceptions WHEN OLD.active=1 BEGIN
 SELECT CASE WHEN ${exceptionConflict('OLD')} THEN RAISE(ABORT,'recurring_conflict') END;
 END`,
 `CREATE TRIGGER IF NOT EXISTS recurring_exception_insert_version AFTER INSERT ON recurring_block_exceptions BEGIN
 UPDATE recurring_blocks SET version=version+1,updated_by=NEW.updated_by,updated_at=datetime('now') WHERE id=NEW.rule_id;
 END`,
 `CREATE TRIGGER IF NOT EXISTS recurring_exception_update_version AFTER UPDATE ON recurring_block_exceptions BEGIN
 UPDATE recurring_blocks SET version=version+1,updated_by=NEW.updated_by,updated_at=datetime('now') WHERE id=NEW.rule_id;
 END`,
 `CREATE TRIGGER IF NOT EXISTS recurring_exception_delete_version AFTER DELETE ON recurring_block_exceptions BEGIN
 UPDATE recurring_blocks SET version=version+1,updated_by=OLD.updated_by,updated_at=datetime('now') WHERE id=OLD.rule_id;
 END`,
 `CREATE TRIGGER IF NOT EXISTS recurring_audit_insert AFTER INSERT ON recurring_blocks BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('recurring_block',NEW.id,'create',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),'system'),NULL,${ruleSnapshot('NEW')});
 END`,
 `CREATE TRIGGER IF NOT EXISTS recurring_audit_update AFTER UPDATE ON recurring_blocks BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('recurring_block',NEW.id,'update',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),'system'),${ruleSnapshot('OLD')},${ruleSnapshot('NEW')});
 END`,
 `CREATE TRIGGER IF NOT EXISTS recurring_audit_exception_insert AFTER INSERT ON recurring_block_exceptions BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('recurring_exception',NEW.rule_id||'/'||NEW.date,'create',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),'system'),NULL,${exceptionSnapshot('NEW')});
 END`,
 `CREATE TRIGGER IF NOT EXISTS recurring_audit_exception_update AFTER UPDATE ON recurring_block_exceptions BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('recurring_exception',NEW.rule_id||'/'||NEW.date,'update',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),'system'),${exceptionSnapshot('OLD')},${exceptionSnapshot('NEW')});
 END`,
 `CREATE TRIGGER IF NOT EXISTS recurring_audit_exception_delete AFTER DELETE ON recurring_block_exceptions BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('recurring_exception',OLD.rule_id||'/'||OLD.date,'delete',coalesce((SELECT name FROM users WHERE id=OLD.updated_by),'system'),${exceptionSnapshot('OLD')},NULL);
 END`
];

export const RECURRENCE_OBJECTS=RECURRENCE_SCHEMA.map(sql=>{const match=/^CREATE (TABLE|INDEX|TRIGGER) IF NOT EXISTS (\w+)/.exec(sql);return {type:match[1].toLowerCase(),name:match[2]};});
export const RECURRENCE_MIGRATION='0003_recurring_blocks.sql';
