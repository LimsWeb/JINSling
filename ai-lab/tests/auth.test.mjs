import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleLab } from '../src/server.mjs';
import { fixture, OWNER_CODE, MEMBER_CODE } from './helpers.mjs';

test('sandbox stage is checked before the bound database can be touched', async () => {
  let calls = 0;
  const response = await handleLab(new Request('https://lab.example/api/session'), {
    LAB_STAGE: 'production', LAB_DB: { prepare() { calls++; throw new Error('must not touch'); } },
    LAB_OWNER_CODE: OWNER_CODE, LAB_MEMBER_CODE: MEMBER_CODE,
  });
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  assert.equal((await response.json()).error.code, 'LAB_ISOLATION_GUARD');
});

test('missing sandbox marker fails read-only without creating tables in a wrong database', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE existing_data (value TEXT); INSERT INTO existing_data VALUES (\'untouched\')');
  const queries = [];
  const binding = {
    prepare(sql) { queries.push(sql); return { async first() { return sqlite.prepare(sql).get(); } }; },
    async batch() { throw new Error('a wrong database must never receive writes'); },
  };
  try {
    const response = await handleLab(new Request('https://lab.example/api/session'), {
      LAB_STAGE: 'sandbox', LAB_DB: binding, LAB_OWNER_CODE: OWNER_CODE, LAB_MEMBER_CODE: MEMBER_CODE,
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'LAB_ISOLATION_GUARD');
    assert.deepEqual(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name), ['existing_data']);
    assert.equal(sqlite.prepare('SELECT value FROM existing_data').get().value, 'untouched');
    assert.equal(queries.length, 1);
    assert.match(queries[0], /lab_meta/);
  } finally { sqlite.close(); }
});

test('login requires JSON, a matching origin, and the lab CSRF header', async t => {
  const f = fixture(t);
  const body = { account: 'owner', access_code: OWNER_CODE };
  for (const options of [{ origin: null }, { origin: 'https://evil.example' }, { csrf: false }]) {
    const result = await f.call('/api/login', { method: 'POST', body, ...options });
    assert.equal(result.status, 403);
  }
  assert.equal((await f.call('/api/login', { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.call('/api/login', { method: 'POST', body: '{broken' })).status, 400);
  assert.equal((await f.call('/api/login', { method: 'POST', body: { ...body, role: 'owner' } })).status, 400);
  assert.equal((await f.call('/api/login', { method: 'POST', body: { ...body, access_code: 'x'.repeat(5000) } })).status, 413);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM lab_sessions').get().n, 0);
});

test('access codes cannot grant owner access through member or unknown accounts', async t => {
  const f = fixture(t);
  for (const body of [
    { account: 'owner', access_code: MEMBER_CODE },
    { account: 'member_a', access_code: OWNER_CODE },
    { account: 'new-owner', access_code: OWNER_CODE },
    { account: '__proto__', access_code: MEMBER_CODE },
  ]) assert.equal((await f.call('/api/login', { method: 'POST', body })).status, 401);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM lab_sessions').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM lab_users').get().n, 4);
});

test('session cookies are secure, opaque, and stored only as hashes', async t => {
  const f = fixture(t);
  const session = await f.login('member_a');
  const header = session.response.headers.get('Set-Cookie');
  assert.match(header, /^__Host-jinsling_lab_session=[0-9a-f]{64};/);
  for (const flag of [/HttpOnly/i, /(?:^|;\s*)Secure(?:;|$)/i, /SameSite=Strict/i, /Path=\//i]) assert.match(header, flag);
  assert.doesNotMatch(header, /Domain=/i);
  const row = f.sqlite.prepare('SELECT * FROM lab_sessions').get();
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.token_hash, session.cookie.split('=')[1]);
  assert.equal(row.user_id, 'member_a');
  const current = await f.call('/api/session', { cookie: session.cookie });
  assert.deepEqual(current.data.user, { id: 'member_a', name: '가상회원 A', role: 'member', status: 'approved' });
  assert.equal(current.data.ai_mode, 'simulation');
  assert.equal(current.data.live_ready, false);
  assert.equal(current.response.headers.get('Cache-Control'), 'no-store');
});

test('every request renews membership status, and expired/logged-out sessions cannot act', async t => {
  const f = fixture(t);
  const { cookie } = await f.login();
  f.sqlite.prepare("UPDATE lab_users SET status='suspended',version=version+1 WHERE id='member_a'").run();
  assert.equal((await f.call('/api/session', { cookie })).data.user.status, 'suspended');
  assert.equal((await f.call('/api/dashboard?date=2026-11-10', { cookie })).status, 403);
  assert.equal((await f.call('/api/logout', { method: 'POST', cookie, body: {} })).status, 200);
  assert.equal((await f.call('/api/session', { cookie })).data.user, null);
  f.sqlite.prepare("UPDATE lab_users SET status='approved',version=version+1 WHERE id='member_a'").run();
  const second = await f.login();
  t.mock.timers.setTime(Date.now() + 9 * 60 * 60 * 1000);
  assert.equal((await f.call('/api/session', { cookie: second.cookie })).data.user, null);
  assert.equal((await f.call('/api/dashboard', { cookie: second.cookie })).status, 401);
});

test('short or shared owner/member secrets fail configuration without writing a session', async t => {
  const f = fixture(t, { LAB_OWNER_CODE: 'short' });
  assert.equal((await f.call('/api/session')).status, 503);
  f.env.LAB_OWNER_CODE = MEMBER_CODE;
  assert.equal((await f.call('/api/login', { method: 'POST', body: { account: 'owner', access_code: MEMBER_CODE } })).status, 503);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM lab_sessions').get().n, 0);
});

test('dashboard enforces Seoul date horizon, business hours, and member privacy', async t => {
  const f = fixture(t);
  const member = await f.login();
  const weekday = await f.call('/api/dashboard?date=2026-11-10', { cookie: member.cookie });
  assert.equal(weekday.status, 200);
  assert.equal(weekday.data.slots.length, 22);
  assert.deepEqual(weekday.data.slots[0], { start_time: '09:00', end_time: '09:30', available: true, status: 'available' });
  assert.equal(weekday.data.slots.at(-1).end_time, '20:00');
  assert.equal('members' in weekday.data, false);
  assert.equal('blocks' in weekday.data, false);
  const saturday = await f.call('/api/dashboard?date=2026-11-14', { cookie: member.cookie });
  assert.equal(saturday.data.slots.length, 10);
  assert.equal(saturday.data.slots.at(-1).end_time, '14:00');
  assert.deepEqual((await f.call('/api/dashboard?date=2026-11-15', { cookie: member.cookie })).data.slots, []);
  assert.equal((await f.call('/api/dashboard?date=2026-11-09', { cookie: member.cookie })).data.slots[0].status, 'past');
  for (const date of ['2026-11-08', '2026-12-10', '2026-02-30', '2026-1-2', 'nonsense']) {
    assert.equal((await f.call(`/api/dashboard?date=${date}`, { cookie: member.cookie })).status, 400, date);
  }
  const owner = await f.login('owner');
  const dashboard = await f.call('/api/dashboard?date=2026-11-10', { cookie: owner.cookie });
  assert.deepEqual(dashboard.data.members.map(x => x.id).sort(), ['member_a', 'member_b', 'owner', 'pending']);
  assert.deepEqual(dashboard.data.blocks, []);
});
