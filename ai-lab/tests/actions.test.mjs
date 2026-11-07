import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, proposal, confirm, book, NOW } from './helpers.mjs';

const slot = { date: '2026-11-10', start_time: '10:00' };
const count = (f, table) => f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test('a proposal is inert until confirmed, expires in five minutes, and confirms idempotently', async t => {
  const f = fixture(t);
  const { cookie } = await f.login();
  const p = await proposal(f, cookie, 'book', slot);
  assert.equal(p.action, 'book');
  assert.equal(Date.parse(p.expires_at), NOW + 300000);
  assert.equal(count(f, 'lab_bookings'), 0);
  assert.equal(count(f, 'lab_audit'), 0);
  const responses = await Promise.all([confirm(f, cookie, p.id), confirm(f, cookie, p.id)]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.deepEqual(responses.map(r => r.data.replayed).sort(), [false, true]);
  assert.deepEqual(responses[0].data.result, responses[1].data.result);
  assert.equal(responses[0].data.result.booking.member_id, 'member_a');
  assert.equal(count(f, 'lab_bookings'), 1);
  assert.equal(count(f, 'lab_audit'), 1);
  const replay = await confirm(f, cookie, p.id);
  assert.equal(replay.data.replayed, true);
  assert.equal(count(f, 'lab_bookings'), 1);
});

test('proposals are actor-bound and another member cannot cancel or inspect a booking', async t => {
  const f = fixture(t);
  const a = await f.login('member_a'), b = await f.login('member_b');
  const p = await proposal(f, a.cookie, 'book', slot);
  assert.equal((await confirm(f, b.cookie, p.id)).status, 404);
  const result = await confirm(f, a.cookie, p.id);
  const id = result.data.result.booking.id;
  const attempt = await f.call('/api/propose', { method: 'POST', cookie: b.cookie, body: { action: 'cancel', data: { booking_id: id } } });
  assert.equal(attempt.status, 404);
  const bView = await f.call('/api/dashboard?date=2026-11-10', { cookie: b.cookie });
  assert.deepEqual(bView.data.bookings, []);
  assert.equal(bView.data.slots.find(x => x.start_time === '10:00').status, 'booked');
  assert.equal(JSON.stringify(bView.data).includes('가상회원 A'), false);
  assert.equal(JSON.stringify(bView.data).includes(id), false);
  const own = await f.call('/api/dashboard?date=2026-11-10', { cookie: a.cookie });
  assert.equal(own.data.bookings[0].id, id);
});

test('pending members cannot book, and members cannot choose another identity or owner action', async t => {
  const f = fixture(t);
  const pending = await f.login('pending'), member = await f.login();
  assert.equal((await f.call('/api/propose', { method: 'POST', cookie: pending.cookie, body: { action: 'book', data: slot } })).status, 403);
  for (const [action, data] of [
    ['book', { ...slot, member_id: 'member_b' }],
    ['block', { date: slot.date, period: 'day' }],
    ['unblock', { block_id: 'any-id' }],
    ['member_status', { member_id: 'member_b', status: 'approved' }],
  ]) assert.equal((await f.call('/api/propose', { method: 'POST', cookie: member.cookie, body: { action, data } })).status, 403);
  assert.equal(count(f, 'lab_proposals'), 0);
});

test('two simultaneous confirmations for one slot create only one booking', async t => {
  const f = fixture(t);
  const a = await f.login('member_a'), b = await f.login('member_b');
  const p = await proposal(f, a.cookie, 'book', slot), q = await proposal(f, b.cookie, 'book', slot);
  const results = await Promise.all([confirm(f, a.cookie, p.id), confirm(f, b.cookie, q.id)]);
  assert.deepEqual(results.map(x => x.status).sort(), [200, 409]);
  assert.equal(count(f, 'lab_bookings'), 1);
  assert.equal(count(f, 'lab_audit'), 1);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM lab_proposals WHERE state='confirmed'").get().n, 1);
});

test('a duplicate confirmation whose earlier read was delayed still returns the committed result', async t => {
  const f = fixture(t);
  const { cookie } = await f.login();
  const p = await proposal(f, cookie, 'book', slot);
  let release, signal;
  const held = new Promise(resolve => { release = resolve; });
  const observed = new Promise(resolve => { signal = resolve; });
  let intercept = true;
  const base = f.env.LAB_DB;
  const delayed = statement => ({
    bind(...values) { return delayed(statement.bind(...values)); },
    async first(...args) {
      const row = await statement.first(...args);
      if (intercept) { intercept = false; signal(); await held; }
      return row;
    },
  });
  f.env.LAB_DB = {
    prepare(sql) { const statement = base.prepare(sql); return sql.startsWith('SELECT * FROM lab_proposals') ? delayed(statement) : statement; },
    batch: base.batch.bind(base),
  };
  const slow = confirm(f, cookie, p.id);
  await observed;
  const committed = await confirm(f, cookie, p.id);
  release();
  const replay = await slow;
  assert.equal(committed.status, 200);
  assert.equal(replay.status, 200, JSON.stringify(replay.json));
  assert.equal(replay.data.replayed, true);
  assert.deepEqual(replay.data.result, committed.data.result);
  assert.equal(count(f, 'lab_bookings'), 1);
  assert.equal(count(f, 'lab_audit'), 1);
});

test('a delayed duplicate unlock confirmation replays its stored result after the block is deleted', async t => {
  const f = fixture(t);
  const { cookie } = await f.login('owner');
  const blockProposal = await proposal(f, cookie, 'block', { date: slot.date, period: 'morning' });
  const blockResult = await confirm(f, cookie, blockProposal.id);
  assert.equal(blockResult.status, 200);
  const blockId = blockResult.data.result.block.id;
  const p = await proposal(f, cookie, 'unblock', { block_id: blockId });
  let release, signal;
  const held = new Promise(resolve => { release = resolve; });
  const observed = new Promise(resolve => { signal = resolve; });
  let intercept = true;
  const base = f.env.LAB_DB;
  const delayed = statement => ({
    bind(...values) { return delayed(statement.bind(...values)); },
    async first(...args) {
      const row = await statement.first(...args);
      if (intercept) { intercept = false; signal(); await held; }
      return row;
    },
  });
  f.env.LAB_DB = {
    prepare(sql) { const statement = base.prepare(sql); return sql.startsWith('SELECT * FROM lab_proposals') ? delayed(statement) : statement; },
    batch: base.batch.bind(base),
  };
  const slow = confirm(f, cookie, p.id);
  await observed;
  const committed = await confirm(f, cookie, p.id);
  release();
  const replay = await slow;
  assert.equal(committed.status, 200);
  assert.equal(replay.status, 200, JSON.stringify(replay.json));
  assert.equal(replay.data.replayed, true);
  assert.deepEqual(replay.data.result, { block_id: blockId, removed: true });
  assert.deepEqual(replay.data.result, committed.data.result);
  assert.deepEqual(replay.data.result, JSON.parse(f.sqlite.prepare('SELECT result_json FROM lab_proposals WHERE id=?').get(p.id).result_json));
  assert.equal(count(f, 'lab_blocks'), 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM lab_audit WHERE proposal_id=?').get(p.id).n, 1);
});

test('a later booking prevents a proposed closure and no booking is cancelled automatically', async t => {
  const f = fixture(t);
  const owner = await f.login('owner'), member = await f.login();
  const p = await proposal(f, owner.cookie, 'block', { date: slot.date, period: 'day' });
  await book(f, member.cookie, slot);
  assert.equal((await confirm(f, owner.cookie, p.id)).status, 409);
  assert.equal(count(f, 'lab_blocks'), 0);
  assert.equal(f.sqlite.prepare('SELECT status FROM lab_bookings').get().status, 'booked');
  assert.equal((await f.call('/api/propose', { method: 'POST', cookie: owner.cookie, body: { action: 'block', data: { date: slot.date, period: 'morning' } } })).status, 409);
});

test('a closure confirmed after booking preview is authoritative at final booking confirmation', async t => {
  const f = fixture(t);
  const owner = await f.login('owner'), member = await f.login();
  const p = await proposal(f, member.cookie, 'book', slot);
  const closed = await proposal(f, owner.cookie, 'block', { date: slot.date, period: 'morning' });
  assert.equal((await confirm(f, owner.cookie, closed.id)).status, 200);
  assert.equal((await confirm(f, member.cookie, p.id)).status, 409);
  assert.equal(count(f, 'lab_bookings'), 0);
  assert.equal(count(f, 'lab_blocks'), 1);
});

test('half-day closures use noon and unlocking one closure preserves another overlapping closure', async t => {
  const f = fixture(t);
  const owner = await f.login('owner');
  const morning = await proposal(f, owner.cookie, 'block', { date: slot.date, period: 'morning' });
  const morningResult = await confirm(f, owner.cookie, morning.id);
  let view = await f.call('/api/dashboard?date=2026-11-10', { cookie: owner.cookie });
  assert.equal(view.data.slots.find(x => x.start_time === '11:30').status, 'blocked');
  assert.equal(view.data.slots.find(x => x.start_time === '12:00').status, 'available');
  const day = await proposal(f, owner.cookie, 'block', { date: slot.date, period: 'day' });
  await confirm(f, owner.cookie, day.id);
  const release = await proposal(f, owner.cookie, 'unblock', { block_id: morningResult.data.result.block.id });
  await confirm(f, owner.cookie, release.id);
  view = await f.call('/api/dashboard?date=2026-11-10', { cookie: owner.cookie });
  assert.equal(view.data.blocks.length, 1);
  assert.equal(view.data.blocks[0].period, 'day');
  assert.equal(view.data.slots.find(x => x.start_time === '11:30').status, 'blocked');
  assert.equal(view.data.slots.find(x => x.start_time === '12:00').status, 'blocked');
});

test('member suspension and later reapproval cannot revive a stale booking proposal', async t => {
  const f = fixture(t);
  const owner = await f.login('owner'), member = await f.login();
  const p = await proposal(f, member.cookie, 'book', slot);
  const suspend = await proposal(f, owner.cookie, 'member_status', { member_id: 'member_a', status: 'suspended' });
  await confirm(f, owner.cookie, suspend.id);
  assert.equal((await confirm(f, member.cookie, p.id)).status, 403);
  const approve = await proposal(f, owner.cookie, 'member_status', { member_id: 'member_a', status: 'approved' });
  await confirm(f, owner.cookie, approve.id);
  const stale = await confirm(f, member.cookie, p.id);
  assert.equal(stale.status, 409);
  assert.equal(stale.error.code, 'STALE_PROPOSAL');
  assert.equal(count(f, 'lab_bookings'), 0);
});

test('stale member-status proposals fail and the owner account cannot be changed as a member', async t => {
  const f = fixture(t);
  const { cookie } = await f.login('owner');
  const p = await proposal(f, cookie, 'member_status', { member_id: 'pending', status: 'approved' });
  const q = await proposal(f, cookie, 'member_status', { member_id: 'pending', status: 'suspended' });
  assert.equal((await confirm(f, cookie, p.id)).status, 200);
  const stale = await confirm(f, cookie, q.id);
  assert.equal(stale.status, 409);
  assert.equal(stale.error.code, 'STALE_PROPOSAL');
  assert.equal(f.sqlite.prepare("SELECT status FROM lab_users WHERE id='pending'").get().status, 'approved');
  assert.equal((await f.call('/api/propose', { method: 'POST', cookie, body: { action: 'member_status', data: { member_id: 'owner', status: 'suspended' } } })).status, 400);
});

test('cancellation is confirmed once and a stale cancellation cannot affect a replacement booking', async t => {
  const f = fixture(t);
  const { cookie } = await f.login();
  const original = await book(f, cookie, slot);
  const p = await proposal(f, cookie, 'cancel', { booking_id: original.id });
  const stale = await proposal(f, cookie, 'cancel', { booking_id: original.id });
  assert.equal(f.sqlite.prepare('SELECT status FROM lab_bookings WHERE id=?').get(original.id).status, 'booked');
  assert.equal((await confirm(f, cookie, p.id)).status, 200);
  const replacement = await book(f, cookie, slot);
  assert.notEqual(replacement.id, original.id);
  assert.equal((await confirm(f, cookie, stale.id)).status, 409);
  assert.equal(f.sqlite.prepare('SELECT status FROM lab_bookings WHERE id=?').get(replacement.id).status, 'booked');
  assert.equal((await confirm(f, cookie, p.id)).data.replayed, true);
});

test('expired confirmations and malformed action arguments never mutate domain records', async t => {
  const f = fixture(t);
  const { cookie } = await f.login();
  const p = await proposal(f, cookie, 'book', slot);
  t.mock.timers.setTime(NOW + 300001);
  const expired = await confirm(f, cookie, p.id);
  assert.equal(expired.status, 410);
  assert.equal(expired.error.code, 'PROPOSAL_EXPIRED');
  assert.equal((await confirm(f, cookie, 'no-such-id')).status, 404);
  for (const data of [
    { ...slot, start_time: '10:15' }, { ...slot, start_time: '20:00' }, { date: '2026-11-15', start_time: '10:00' },
    { date: '2026-11-09', start_time: '09:00' }, { ...slot, role: 'owner' }, { ...slot, start_time: ['10:00'] },
  ]) assert.equal((await f.call('/api/propose', { method: 'POST', cookie, body: { action: 'book', data } })).status, 400);
  assert.equal(count(f, 'lab_bookings'), 0);
  assert.equal(count(f, 'lab_audit'), 0);
});

test('weekday daily capacity is enforced atomically even for competing different slots', async t => {
  const f = fixture(t);
  const owner = await f.login('owner');
  for (let i = 0; i < 17; i++) {
    const start = `${String(9 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
    await book(f, owner.cookie, { date: slot.date, start_time: start, member_id: 'member_a' });
  }
  const p = await proposal(f, owner.cookie, 'book', { date: slot.date, start_time: '17:30', member_id: 'member_a' });
  const q = await proposal(f, owner.cookie, 'book', { date: slot.date, start_time: '18:00', member_id: 'member_b' });
  const results = await Promise.all([confirm(f, owner.cookie, p.id), confirm(f, owner.cookie, q.id)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM lab_bookings WHERE status='booked'").get().n, 18);
  const view = await f.call('/api/dashboard?date=2026-11-10', { cookie: owner.cookie });
  assert.equal(view.data.slots.find(x => x.start_time === '19:30').status, 'capacity');
});

test('membership changes between the server precheck and atomic commit are rejected by the DB', async t => {
  const f = fixture(t);
  const { cookie } = await f.login();
  const p = await proposal(f, cookie, 'book', slot);
  const base = f.env.LAB_DB;
  f.env.LAB_DB = {
    prepare: base.prepare.bind(base),
    async batch(statements) {
      f.sqlite.prepare("UPDATE lab_users SET status='suspended',version=version+1 WHERE id='member_a'").run();
      return base.batch(statements);
    },
  };
  const result = await confirm(f, cookie, p.id);
  assert.ok([403, 409].includes(result.status), JSON.stringify(result.json));
  assert.equal(count(f, 'lab_bookings'), 0);
  assert.equal(count(f, 'lab_audit'), 0);
  assert.equal(f.sqlite.prepare('SELECT state FROM lab_proposals WHERE id=?').get(p.id).state, 'pending');
});

test('booking inserted after a closure precheck rolls back both the closure and its confirmation', async t => {
  const f = fixture(t);
  const { cookie } = await f.login('owner');
  const p = await proposal(f, cookie, 'block', { date: slot.date, period: 'morning' });
  const base = f.env.LAB_DB;
  f.env.LAB_DB = {
    prepare: base.prepare.bind(base),
    async batch(statements) {
      f.sqlite.prepare(`INSERT INTO lab_bookings (id,member_id,date,start_time,end_time,status,version,created_by,created_at,updated_at)
        VALUES ('racing-booking','member_a','2026-11-10','10:00','10:30','booked',1,'member_a',?,?)`).run(NOW, NOW);
      return base.batch(statements);
    },
  };
  const result = await confirm(f, cookie, p.id);
  assert.equal(result.status, 409);
  assert.equal(count(f, 'lab_blocks'), 0);
  assert.equal(count(f, 'lab_bookings'), 1);
  assert.equal(count(f, 'lab_audit'), 0);
  assert.equal(f.sqlite.prepare('SELECT state FROM lab_proposals WHERE id=?').get(p.id).state, 'pending');
});
