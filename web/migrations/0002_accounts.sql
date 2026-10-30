-- Additive upgrade: user and booking IDs are preserved. 0001 stays immutable.
ALTER TABLE settings ADD COLUMN member_limit INTEGER NOT NULL DEFAULT 100 CHECK(member_limit BETWEEN 1 AND 1000);
ALTER TABLE settings ADD COLUMN registration_open INTEGER NOT NULL DEFAULT 1 CHECK(registration_open IN(0,1));
UPDATE settings SET member_limit=max(100,pilot_member_limit);

ALTER TABLE users ADD COLUMN username TEXT CHECK(username IS NULL OR (length(username) BETWEEN 4 AND 32 AND username=lower(username) AND username NOT GLOB '*[^a-z0-9_]*'));
ALTER TABLE users ADD COLUMN provider_uid TEXT CHECK(provider_uid IS NULL OR length(provider_uid) BETWEEN 1 AND 128);
ALTER TABLE users ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0 CHECK(credential_revision>=0);
ALTER TABLE users ADD COLUMN password_reset_required INTEGER NOT NULL DEFAULT 0 CHECK(password_reset_required IN(0,1));
ALTER TABLE users ADD COLUMN reset_token_hash TEXT;
ALTER TABLE users ADD COLUMN reset_expires_at TEXT;
-- A nonexpiring lock deliberately fails closed after an uncertain provider write.
-- Only a finished operation or the documented offline owner recovery clears it.
ALTER TABLE users ADD COLUMN credential_lock TEXT;
ALTER TABLE users ADD COLUMN credential_lock_started_at TEXT;
CREATE UNIQUE INDEX users_username ON users(username COLLATE NOCASE) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX users_provider_uid ON users(provider_uid) WHERE provider_uid IS NOT NULL;
CREATE UNIQUE INDEX users_reset_token ON users(reset_token_hash) WHERE reset_token_hash IS NOT NULL;
ALTER TABLE sessions ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'full' CHECK(scope IN('full','legacy'));
UPDATE sessions SET scope='legacy';

DROP TRIGGER users_insert_guard;
CREATE TRIGGER users_insert_guard BEFORE INSERT ON users BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM users)>=(SELECT member_limit FROM settings WHERE id=1) THEN RAISE(ABORT,'member_limit') END;
 SELECT CASE WHEN NEW.role='user' AND (SELECT registration_open FROM settings WHERE id=1)=0 THEN RAISE(ABORT,'registration_closed') END;
 SELECT CASE WHEN NEW.invite_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM invites WHERE id=NEW.invite_id AND used_at IS NULL AND revoked_at IS NULL AND expires_at>datetime('now')) THEN RAISE(ABORT,'invalid_invite') END;
 SELECT CASE WHEN (NEW.username IS NULL)!=(NEW.provider_uid IS NULL) THEN RAISE(ABORT,'credential_identity_constraint') END;
END;
CREATE TRIGGER users_credentials_guard BEFORE UPDATE OF username,provider_uid ON users BEGIN
 SELECT CASE WHEN (NEW.username IS NULL)!=(NEW.provider_uid IS NULL) THEN RAISE(ABORT,'credential_identity_constraint') END;
END;
DROP TRIGGER users_revoke_sessions;
CREATE TRIGGER users_revoke_sessions AFTER UPDATE OF status,key_hash,credential_revision,password_reset_required,credential_lock ON users
 WHEN NEW.key_hash!=OLD.key_hash OR NEW.credential_revision!=OLD.credential_revision OR NEW.password_reset_required=1 OR NEW.credential_lock IS NOT NULL OR NEW.status IN('suspended','rejected') BEGIN
 DELETE FROM sessions WHERE user_id=NEW.id;
END;
-- Even a suspension immediately followed by approval invalidates an in-flight login.
CREATE TRIGGER users_suspension_revision AFTER UPDATE OF status ON users WHEN NEW.status IN('suspended','rejected') AND NEW.status!=OLD.status BEGIN
 UPDATE users SET credential_revision=credential_revision+1 WHERE id=NEW.id;
END;
CREATE TRIGGER sessions_account_guard BEFORE INSERT ON sessions BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users u WHERE u.id=NEW.user_id AND u.status IN('pending','approved') AND u.credential_revision=NEW.credential_revision AND u.password_reset_required=0 AND u.credential_lock IS NULL AND ((NEW.scope='full' AND u.provider_uid IS NOT NULL) OR (NEW.scope='legacy' AND u.provider_uid IS NULL AND u.username IS NULL))) THEN RAISE(ABORT,'session_credential_conflict') END;
END;
DROP TRIGGER settings_guard;
CREATE TRIGGER settings_guard BEFORE UPDATE ON settings BEGIN
 SELECT CASE WHEN NEW.member_limit<(SELECT count(*) FROM users) THEN RAISE(ABORT,'member_limit') END;
END;

-- Explicit safe audit shapes: no passwords, provider UIDs, hashes, lock or reset tokens.
DROP TRIGGER audit_users_insert;
CREATE TRIGGER audit_users_insert AFTER INSERT ON users BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('user',NEW.id,'create',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),NEW.name),NULL,json_object('id',NEW.id,'username',NEW.username,'name',NEW.name,'phone',NEW.phone,'role',NEW.role,'status',NEW.status,'password_reset_required',NEW.password_reset_required));
END;
DROP TRIGGER audit_users_update;
CREATE TRIGGER audit_users_update AFTER UPDATE ON users BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('user',NEW.id,'update',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),NEW.name),json_object('id',OLD.id,'username',OLD.username,'name',OLD.name,'phone',OLD.phone,'role',OLD.role,'status',OLD.status,'password_reset_required',OLD.password_reset_required),json_object('id',NEW.id,'username',NEW.username,'name',NEW.name,'phone',NEW.phone,'role',NEW.role,'status',NEW.status,'password_reset_required',NEW.password_reset_required));
END;
DROP TRIGGER audit_settings_insert;
CREATE TRIGGER audit_settings_insert AFTER INSERT ON settings BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('settings',NEW.id,'create',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),'system'),NULL,json_object('shop_name',NEW.shop_name,'contact_phone',NEW.contact_phone,'booking_window_days',NEW.booking_window_days,'cancel_before_minutes',NEW.cancel_before_minutes,'member_limit',NEW.member_limit,'registration_open',NEW.registration_open));
END;
DROP TRIGGER audit_settings_update;
CREATE TRIGGER audit_settings_update AFTER UPDATE ON settings BEGIN
 INSERT INTO audit_log(entity_type,entity_id,action,actor_name,before_data,after_data) VALUES ('settings',NEW.id,'update',coalesce((SELECT name FROM users WHERE id=NEW.updated_by),'system'),json_object('shop_name',OLD.shop_name,'contact_phone',OLD.contact_phone,'booking_window_days',OLD.booking_window_days,'cancel_before_minutes',OLD.cancel_before_minutes,'member_limit',OLD.member_limit,'registration_open',OLD.registration_open),json_object('shop_name',NEW.shop_name,'contact_phone',NEW.contact_phone,'booking_window_days',NEW.booking_window_days,'cancel_before_minutes',NEW.cancel_before_minutes,'member_limit',NEW.member_limit,'registration_open',NEW.registration_open));
END;
