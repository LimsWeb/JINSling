import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let production = {}, development = {};
try { production = await import('../server/password-provider.mjs'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
try { development = await import('../dev/password-auth.mjs'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  type: 'service_account', project_id: 'salon-project', private_key_id: 'fixture-key-id',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'salon-auth@salon-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
};
const configured = () => ({
  FIREBASE_API_KEY: 'test-api-key', FIREBASE_PROJECT_ID: 'salon-project',
  FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount),
});
const password = '  salon password 🔑  ';
const auth = (env = configured()) => {
  assert.equal(typeof production.createPasswordAuth, 'function', 'production password provider must exist');
  return production.createPasswordAuth(env);
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
// These are deliberately unsigned fixtures: only the provider's own HTTPS response
// is decoded, and no public API accepts a browser-supplied identity token.
function identity(overrides = {}, claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: 'salon-project', iss: 'https://securetoken.google.com/salon-project', sub: 'firebase-user-1',
    user_id: 'firebase-user-1', email: 'member_01@jinsling-auth.invalid', iat: now, exp: now + 3600,
    auth_time: now, firebase: { sign_in_provider: 'password' }, ...claims };
  return { localId: 'firebase-user-1', email: 'member_01@jinsling-auth.invalid', displayName: '',
    idToken: `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.fixture-signature`,
    refreshToken: 'provider-refresh-secret', expiresIn: '3600', registered: true, ...overrides };
}
function hasCode(code) {
  return error => {
    assert.equal(error.name, 'AuthProviderError');
    assert.equal(error.code, code);
    for (const secret of [password, 'test-api-key', 'provider-refresh-secret', 'sensitive-provider-body', 'oauth-token-secret']) {
      assert.equal(String(error.stack).includes(secret), false, 'provider error must not expose credentials or raw responses');
    }
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('production requires complete matching configuration and never falls back to development auth', t => {
  assert.equal(typeof production.passwordAuthReady, 'function', 'configuration readiness helper must exist');
  t.mock.method(globalThis, 'fetch', () => { assert.fail('invalid configuration must not make a network request'); });
  for (const env of [undefined, {}, { FIREBASE_API_KEY: 'test-api-key' }, { ...configured(), FIREBASE_SERVICE_ACCOUNT_JSON: '{' },
    { ...configured(), FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...serviceAccount, project_id: 'other-project' }) },
    { ...configured(), FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...serviceAccount, token_uri: 'https://attacker.invalid/token' }) }]) {
    assert.equal(production.passwordAuthReady(env), false);
    assert.throws(() => production.createPasswordAuth(env), hasCode('NOT_CONFIGURED'));
  }
  assert.equal(production.passwordAuthReady(configured()), true);
});

test('only a complete trusted environment adapter can replace the production provider', () => {
  assert.equal(typeof production.passwordAuthReady, 'function', 'configuration readiness helper must exist');
  const injected = { async createUser() {}, async verifyPassword() {}, async setPassword() {}, async deleteUser() {} };
  assert.equal(auth({ AUTH: injected }), injected);
  assert.equal(production.passwordAuthReady({ AUTH: injected }), true);
  assert.equal(production.passwordAuthReady({ AUTH: { verifyPassword() {} } }), false);
  assert.throws(() => auth({ AUTH: { verifyPassword() {} } }), hasCode('NOT_CONFIGURED'));
});

test('password signup and login use fixed Google HTTPS endpoints and preserve the submitted password', async t => {
  const provider = auth(), requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), init, body: JSON.parse(init.body) });
    return json(identity());
  });
  assert.deepEqual(await provider.createUser({ username: 'Member_01', password }), { uid: 'firebase-user-1' });
  assert.deepEqual(await provider.verifyPassword({ username: 'MEMBER_01', password }), { uid: 'firebase-user-1' });
  assert.deepEqual(requests.map(r => r.url), [
    'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=test-api-key',
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=test-api-key',
  ]);
  for (const { init, body } of requests) {
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error', 'credentials must never follow redirects');
    assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
    assert.deepEqual(body, { email: 'member_01@jinsling-auth.invalid', password, returnSecureToken: true });
    assert.ok(init.signal instanceof AbortSignal, 'provider requests must have a deadline');
  }
});

test('a wrong project, mismatched UID, wrong alias, or malformed identity response cannot authenticate', async t => {
  const provider = auth();
  let reply;
  t.mock.method(globalThis, 'fetch', async () => json(reply));
  for (const bad of [identity({}, { aud: 'another-project' }), identity({}, { sub: 'another-user' }),
    identity({}, { iss: 'https://attacker.invalid' }), identity({ email: 'other@jinsling-auth.invalid' }),
    identity({}, { email: 'other@jinsling-auth.invalid' }), identity({}, { exp: 1 }),
    identity({ idToken: 'not-a-token' }), identity({ localId: '' })]) {
    reply = bad;
    await assert.rejects(provider.verifyPassword({ username: 'member_01', password }), hasCode('UNAVAILABLE'));
  }
});

test('documented provider failures become only sanitized application error codes', async t => {
  const provider = auth();
  let reply;
  t.mock.method(globalThis, 'fetch', async () => reply);
  for (const [method, status, message, code] of [
    ['createUser', 400, 'EMAIL_EXISTS', 'USERNAME_TAKEN'],
    ['verifyPassword', 400, 'INVALID_LOGIN_CREDENTIALS', 'INVALID_CREDENTIALS'],
    ['verifyPassword', 400, 'EMAIL_NOT_FOUND', 'INVALID_CREDENTIALS'],
    ['verifyPassword', 400, 'INVALID_PASSWORD', 'INVALID_CREDENTIALS'],
    ['verifyPassword', 400, 'USER_DISABLED', 'INVALID_CREDENTIALS'],
    ['verifyPassword', 400, 'API_KEY_INVALID', 'NOT_CONFIGURED'],
    ['verifyPassword', 429, 'TOO_MANY_ATTEMPTS_TRY_LATER', 'UNAVAILABLE'],
    ['verifyPassword', 500, 'INVALID_PASSWORD', 'UNAVAILABLE'],
  ]) {
    reply = json({ error: { code: status, message: `${message} : sensitive-provider-body ${password}` } }, status);
    await assert.rejects(provider[method]({ username: 'member_01', password }), hasCode(code));
  }
});

test('network exceptions, redirects, and invalid response JSON fail closed without exposing transport details', async t => {
  const provider = auth();
  let behavior = 'throw';
  t.mock.method(globalThis, 'fetch', async () => {
    if (behavior === 'throw') throw new TypeError(`sensitive-provider-body ${password} test-api-key`);
    if (behavior === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid' } });
    return new Response('sensitive-provider-body', { status: 200 });
  });
  for (behavior of ['throw', 'redirect', 'invalid-json']) {
    await assert.rejects(provider.verifyPassword({ username: 'member_01', password }), hasCode('UNAVAILABLE'));
  }
});

test('privileged password update and deletion use a signed scoped OAuth grant and explicit project and UID', async t => {
  const provider = auth(), requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const token = body.get('assertion'), [header, payload, signature] = token.split('.');
      assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
      assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT', kid: 'fixture-key-id' });
      const claims = JSON.parse(Buffer.from(payload, 'base64url'));
      assert.equal(claims.iss, 'salon-auth@salon-project.iam.gserviceaccount.com');
      assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/identitytoolkit');
      assert.equal(claims.exp - claims.iat, 3600);
      assert.equal(claims.sub, undefined, 'service account must not impersonate a person');
      return json({ access_token: 'oauth-token-secret', token_type: 'Bearer', expires_in: 3600 });
    }
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer oauth-token-secret');
    assert.equal(init.redirect, 'error');
    if (String(url).endsWith('accounts:update')) {
      assert.deepEqual(JSON.parse(init.body), { localId: 'firebase-user-1', password });
      return json({ kind: 'identitytoolkit#SetAccountInfoResponse', localId: 'firebase-user-1' });
    }
    assert.deepEqual(JSON.parse(init.body), { localId: 'firebase-user-1' });
    return json({ kind: 'identitytoolkit#DeleteAccountResponse' });
  });
  assert.equal(await provider.setPassword({ uid: 'firebase-user-1', password }), undefined);
  assert.equal(await provider.deleteUser({ uid: 'firebase-user-1' }), undefined);
  assert.deepEqual(requests.map(r => r.url), [
    'https://oauth2.googleapis.com/token',
    'https://identitytoolkit.googleapis.com/v1/projects/salon-project/accounts:update',
    'https://identitytoolkit.googleapis.com/v1/projects/salon-project/accounts:delete',
  ], 'the OAuth token is reused while valid');
});

test('OAuth failure cannot fall back to API-key privileged requests', async t => {
  const provider = auth();
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    return json({ error: 'invalid_grant', error_description: 'sensitive-provider-body' }, 400);
  });
  await assert.rejects(provider.setPassword({ uid: 'firebase-user-1', password }), hasCode('NOT_CONFIGURED'));
});

test('an admin update response for a different UID is rejected', async t => {
  const provider = auth();
  t.mock.method(globalThis, 'fetch', async url => String(url) === 'https://oauth2.googleapis.com/token'
    ? json({ access_token: 'oauth-token-secret', token_type: 'Bearer', expires_in: 3600 })
    : json({ localId: 'different-user' }));
  await assert.rejects(provider.setPassword({ uid: 'firebase-user-1', password }), hasCode('UNAVAILABLE'));
});

test('development passwords remain strong, private, case-normalized, and usable after reopening SQLite', async () => {
  assert.equal(typeof development.createDevelopmentAuth, 'function', 'separate development provider must exist');
  const folder = mkdtempSync(join(tmpdir(), 'jinsling-password-'));
  const filename = join(folder, 'passwords.sqlite');
  let local = development.createDevelopmentAuth(filename);
  try {
    const created = await local.auth.createUser({ username: 'Member_01', password });
    assert.ok(created.uid);
    await assert.rejects(local.auth.createUser({ username: 'MEMBER_01', password }), hasCode('USERNAME_TAKEN'));
    assert.deepEqual(await local.auth.verifyPassword({ username: 'MEMBER_01', password }), created);
    await assert.rejects(local.auth.verifyPassword({ username: 'member_01', password: password.trim() }), hasCode('INVALID_CREDENTIALS'));
    await assert.rejects(local.auth.verifyPassword({ username: 'missing_user', password }), hasCode('INVALID_CREDENTIALS'));
    local.close(); local = development.createDevelopmentAuth(filename);
    assert.deepEqual(await local.auth.verifyPassword({ username: 'member_01', password }), created);
    const changed = 'a new private password 🔐';
    await local.auth.setPassword({ uid: created.uid, password: changed });
    await assert.rejects(local.auth.verifyPassword({ username: 'member_01', password }), hasCode('INVALID_CREDENTIALS'));
    assert.deepEqual(await local.auth.verifyPassword({ username: 'member_01', password: changed }), created);
    const inspection = new DatabaseSync(filename, { readOnly: true });
    try {
      const row = inspection.prepare('SELECT * FROM development_auth_users').get();
      assert.ok(row.iterations >= 600000, 'stored verifier must retain a modern PBKDF2 work factor');
      assert.equal(row.algorithm, 'pbkdf2-sha256');
      assert.ok(row.salt.length >= 32, 'each password requires at least a 128-bit random salt');
      const stored = JSON.stringify(row);
      assert.equal(stored.includes(password), false); assert.equal(stored.includes(changed), false);
      assert.equal(readFileSync(filename).includes(Buffer.from(password)), false);
      assert.equal(readFileSync(filename).includes(Buffer.from(changed)), false);
    } finally { inspection.close(); }
    await local.auth.deleteUser({ uid: created.uid });
    await assert.rejects(local.auth.verifyPassword({ username: 'member_01', password: changed }), hasCode('INVALID_CREDENTIALS'));
  } finally { local.close(); rmSync(folder, { recursive: true, force: true }); }
});
