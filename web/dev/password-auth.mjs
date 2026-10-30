// Node-only synthetic preview adapter. Production must never import this file.
import { pbkdf2, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { AuthProviderError } from '../server/password-provider.mjs';

const derive = promisify(pbkdf2);
const ITERATIONS = 600000;
function usernameValue(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]{4,32}$/.test(value)) throw new AuthProviderError('INVALID_CREDENTIALS');
  return value.toLowerCase();
}
function passwordValue(value) {
  if (typeof value !== 'string' || Array.from(value).length < 15 || Array.from(value).length > 128) throw new AuthProviderError('INVALID_CREDENTIALS');
  return value;
}
function uidValue(value) {
  if (typeof value !== 'string' || !value.length || value.length > 128) throw new AuthProviderError('INVALID_CREDENTIALS');
  return value;
}
function sanitized(error) { return error instanceof AuthProviderError ? error : new AuthProviderError('UNAVAILABLE'); }

export function createDevelopmentAuth(filename = ':memory:') {
  const sqlite = new DatabaseSync(filename);
  try {
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    sqlite.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS development_auth_users (
        uid TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
        algorithm TEXT NOT NULL CHECK(algorithm='pbkdf2-sha256'),
        iterations INTEGER NOT NULL CHECK(iterations>=600000),
        salt TEXT NOT NULL, password_hash TEXT NOT NULL
      );`);
  } catch (error) { sqlite.close(); throw sanitized(error); }
  const missingSalt = randomBytes(32);
  async function verifier(password) {
    const salt = randomBytes(32);
    const hash = await derive(passwordValue(password), salt, ITERATIONS, 32, 'sha256');
    return { salt: salt.toString('hex'), hash: hash.toString('hex') };
  }
  const auth = Object.freeze({
    async createUser({ username, password }) {
      try {
        const canonical = usernameValue(username);
        if (sqlite.prepare('SELECT 1 FROM development_auth_users WHERE username=?').get(canonical)) throw new AuthProviderError('USERNAME_TAKEN');
        const { salt, hash } = await verifier(password), uid = randomUUID();
        try {
          sqlite.prepare("INSERT INTO development_auth_users(uid,username,algorithm,iterations,salt,password_hash) VALUES (?,?,'pbkdf2-sha256',?,?,?)")
            .run(uid, canonical, ITERATIONS, salt, hash);
        } catch (error) {
          if (sqlite.prepare('SELECT 1 FROM development_auth_users WHERE username=?').get(canonical)) throw new AuthProviderError('USERNAME_TAKEN');
          throw error;
        }
        return { uid };
      } catch (error) { throw sanitized(error); }
    },
    async verifyPassword({ username, password }) {
      try {
        const row = sqlite.prepare('SELECT * FROM development_auth_users WHERE username=?').get(usernameValue(username));
        const checked = passwordValue(password);
        if (row && (row.algorithm !== 'pbkdf2-sha256' || !Number.isSafeInteger(row.iterations) || row.iterations < ITERATIONS
          || row.iterations > 2000000 || !/^[0-9a-f]{64}$/.test(row.salt) || !/^[0-9a-f]{64}$/.test(row.password_hash))) throw new AuthProviderError('UNAVAILABLE');
        const actual = await derive(checked, row ? Buffer.from(row.salt, 'hex') : missingSalt, row?.iterations ?? ITERATIONS, 32, 'sha256');
        if (!row || !timingSafeEqual(actual, Buffer.from(row.password_hash, 'hex'))) throw new AuthProviderError('INVALID_CREDENTIALS');
        return { uid: row.uid };
      } catch (error) { throw sanitized(error); }
    },
    async setPassword({ uid, password }) {
      try {
        uidValue(uid);
        const { salt, hash } = await verifier(password);
        const result = sqlite.prepare("UPDATE development_auth_users SET algorithm='pbkdf2-sha256',iterations=?,salt=?,password_hash=? WHERE uid=?")
          .run(ITERATIONS, salt, hash, uid);
        if (!result.changes) throw new AuthProviderError('INVALID_CREDENTIALS');
      } catch (error) { throw sanitized(error); }
    },
    async deleteUser({ uid }) {
      try {
        const result = sqlite.prepare('DELETE FROM development_auth_users WHERE uid=?').run(uidValue(uid));
        if (!result.changes) throw new AuthProviderError('INVALID_CREDENTIALS');
      } catch (error) { throw sanitized(error); }
    },
  });
  return { auth, close: () => sqlite.close() };
}
