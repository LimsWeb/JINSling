import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { handleApi } from '../server/api.mjs';
import { AuthProviderError, createPasswordAuth } from '../server/password-provider.mjs';
import { createTestDatabase } from './sqlite-d1.mjs';

const password = 'a private setup password';
const setupToken = 'private-setup-token';
const rawSecret = 'private-upstream-payload';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
  type: 'service_account', project_id: 'salon-project',
  client_email: 'salon-auth@salon-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};
let sequence = 0;
function fixture() {
  const db = createTestDatabase();
  return { ...db, env: { DB: db.binding, BOOTSTRAP_TOKEN: setupToken,
    FIREBASE_API_KEY: 'private-test-api-key', FIREBASE_PROJECT_ID: 'salon-project',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(account) } };
}
const bootstrap = { setup_token: setupToken, username: 'shop_owner', password, name: 'Owner', phone: '01012345678' };
async function request(s, path, body = bootstrap) {
  const response = await handleApi(new Request('https://example.test' + path, {
    method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json',
      'X-JinSling-Request': '1', 'CF-Connecting-IP': `192.0.2.${++sequence}` }, body: JSON.stringify(body),
  }), s.env);
  return { status: response.status, cookie: response.headers.get('Set-Cookie'), body: await response.json() };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function identity(changes = {}, claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { localId: 'provider-user', email: 'shop_owner@jinsling-auth.invalid',
    idToken: `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ aud: 'salon-project',
      iss: 'https://securetoken.google.com/salon-project', sub: 'provider-user', user_id: 'provider-user',
      email: 'shop_owner@jinsling-auth.invalid', iat: now, exp: now + 3600,
      firebase: { sign_in_provider: 'password' }, ...claims })}.fixture-signature`,
    refreshToken: 'private-refresh-token', expiresIn: '3600', ...changes };
}
function diagnostic(result, reason, status) {
  assert.ok(result.status >= 400);
  assert.ok(result.body.error.message.includes(`[진단: CREATE/${reason}/HTTP${status}]`), result.body.error.message);
  assert.equal(result.cookie, null);
  const visible = JSON.stringify(result.body);
  for (const secret of [password, setupToken, rawSecret, 'private-test-api-key', 'private-refresh-token',
    'shop_owner@jinsling-auth.invalid', 'provider-user', account.private_key, bootstrap.phone]) {
    assert.ok(!visible.includes(secret), 'diagnostic must never expose credentials, identities or provider text');
  }
}

test('bootstrap distinguishes provider rejection reasons while discarding raw Google text and metadata', async t => {
  const s = fixture();
  let reply, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return reply; });
  try {
    const cases = [
      [400, { message: 'API key not valid. Please pass a valid API key.' }, 'API_KEY_INVALID'],
      [400, { message: rawSecret, details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', metadata: { secret: rawSecret } }] }, 'API_KEY_INVALID'],
      [400, { message: 'PASSWORD_DOES_NOT_MEET_REQUIREMENTS : ' + rawSecret }, 'PASSWORD_POLICY'],
      [400, { message: 'WEAK_PASSWORD : ' + rawSecret }, 'PASSWORD_POLICY'],
      [400, { message: 'INVALID_EMAIL' }, 'INVALID_EMAIL'],
      [400, { message: 'OPERATION_NOT_ALLOWED' }, 'PROVIDER_DISABLED'],
      [400, { message: 'EMAIL_EXISTS' }, 'EMAIL_EXISTS'],
      [403, { message: rawSecret }, 'ACCESS_DENIED'],
      [429, { message: rawSecret }, 'RATE_LIMITED'],
      [503, { message: 'INVALID_EMAIL' }, 'PROVIDER_UNAVAILABLE'],
      [400, { message: rawSecret, details: [{ reason: rawSecret }] }, 'PROVIDER_REJECTED'],
    ];
    for (const [status, error, reason] of cases) {
      reply = json({ error: { code: status, ...error } }, status);
      diagnostic(await request(s, '/api/bootstrap'), reason, status);
    }
    assert.equal(calls, cases.length, 'signup failure must not trigger an automatic retry or deletion');
    assert.equal(s.sqlite.prepare('SELECT count(*) n FROM users').get().n, 0);
    assert.equal(s.sqlite.prepare('SELECT count(*) n FROM settings').get().n, 0);
  } finally { s.close(); }
});

test('bootstrap separates transport, malformed response and rejected identity without accepting or deleting that identity', async t => {
  const s = fixture();
  let reply, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; if (reply instanceof Error) throw reply; return reply; });
  try {
    const cases = [
      [new TypeError(rawSecret), 'TRANSPORT_FAILURE', 0],
      [new Response(rawSecret, { status: 502 }), 'INVALID_JSON', 502],
      [json([]), 'RESPONSE_SHAPE_INVALID', 200],
      [json(identity({ idToken: rawSecret })), 'IDENTITY_TOKEN', 200],
      [json(identity({ localId: '' })), 'IDENTITY_UID', 200],
      [json(identity({}, { aud: 'other-project' })), 'IDENTITY_PROJECT', 200],
      [json(identity({}, { aud: 'other-project' }), 201), 'IDENTITY_PROJECT', 201],
      [json(identity({}, { iss: 'https://attacker.invalid' })), 'IDENTITY_PROJECT', 200],
      [json(identity({}, { sub: 'other-user' })), 'IDENTITY_UID', 200],
      [json(identity({ email: undefined })), 'IDENTITY_EMAIL', 200],
      [json(identity({}, { email: 'other@example.invalid' })), 'IDENTITY_EMAIL', 200],
      [json(identity({}, { firebase: { sign_in_provider: 'custom' } })), 'IDENTITY_PROVIDER', 200],
      [json(identity({}, { exp: 1 })), 'IDENTITY_TIME', 200],
    ];
    for (const [response, reason, status] of cases) {
      reply = response;
      diagnostic(await request(s, '/api/bootstrap'), reason, status);
    }
    assert.equal(calls, cases.length);
    for (const table of ['users', 'settings', 'sessions']) assert.equal(s.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  } finally { s.close(); }
});

test('bootstrap timeout reports an ambiguous timeout without retrying signup', async t => {
  const s = fixture();
  let entered, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    calls++; entered();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(rawSecret)), { once: true }));
  });
  try {
    const pending = request(s, '/api/bootstrap');
    await started;
    t.mock.timers.tick(10001);
    diagnostic(await pending, 'REQUEST_TIMEOUT', 0);
    assert.equal(calls, 1);
  } finally { s.close(); }
});

test('setup diagnostics require a valid unused bootstrap token and stay absent from public login and registration', async t => {
  const s = fixture();
  let reply = json(identity()), calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return reply; });
  try {
    const denied = await request(s, '/api/bootstrap', { ...bootstrap, setup_token: 'incorrect' });
    assert.equal(denied.body.error.code, 'setup_denied');
    assert.ok(!JSON.stringify(denied.body).includes('진단'));
    assert.equal(calls, 0);
    assert.equal((await request(s, '/api/bootstrap')).status, 200);
    assert.equal(calls, 1);
    const configured = await request(s, '/api/bootstrap');
    assert.equal(configured.body.error.code, 'already_configured');
    assert.equal(calls, 1);
    for (const [path, body] of [
      ['/api/auth/login', { username: 'shop_owner', password }],
      ['/api/auth/join', { username: 'new_member', password, name: 'Member', phone: '01023456789' }],
    ]) {
      reply = json({ error: { message: 'PASSWORD_DOES_NOT_MEET_REQUIREMENTS : ' + rawSecret } }, 400);
      const result = await request(s, path, body);
      assert.equal(result.body.error.code, 'auth_unavailable');
      assert.ok(!JSON.stringify(result.body).includes('진단'));
      assert.ok(!JSON.stringify(result.body).includes(rawSecret));
      assert.equal(result.cookie, null);
    }
  } finally { s.close(); }
});

test('bootstrap never renders arbitrary diagnostic fields from a trusted adapter exception', async () => {
  const s = fixture(), provider = createPasswordAuth(s.env);
  try {
    const error = new AuthProviderError('UNAVAILABLE');
    error.diagnostic = { operation: 'create', reason: rawSecret, status: 400 };
    s.env.AUTH = { ...provider, async createUser() { throw error; } };
    let result = await request(s, '/api/bootstrap');
    assert.equal(result.status, 503);
    assert.ok(!JSON.stringify(result.body).includes(rawSecret));
    error.diagnostic = { operation: 'create', reason: 'INVALID_EMAIL', status: rawSecret };
    result = await request(s, '/api/bootstrap');
    assert.ok(!JSON.stringify(result.body).includes(rawSecret));
  } finally { s.close(); }
});
