import test from 'node:test';
import assert from 'node:assert/strict';

import * as module from '../public/page-refresh.mjs';

function harness(refresh, onError = () => {}) {
  assert.equal(typeof module.startVisibleRefresh, 'function', 'visible-page refresh must be implemented');
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const win = new EventTarget();
  win.navigator = { onLine: true };
  let current = 0, sequence = 0;
  const timers = new Map();
  const controller = module.startVisibleRefresh({
    refresh, onError, documentTarget: doc, windowTarget: win, intervalMs: 30_000,
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: current + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  return {
    doc, win, controller,
    async tick(ms) {
      current += ms;
      const due = [...timers].filter(([, value]) => value.at <= current);
      for (const [id, timer] of due) { timers.delete(id); await timer.callback(); }
      await Promise.resolve();
    },
    async event(target, name) { target.dispatchEvent(new Event(name)); await new Promise(setImmediate); },
    get pendingTimers() { return timers.size; },
  };
}

test('visible screen refreshes after 30 seconds and stops when hidden until return', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; });
  await h.tick(29_999); assert.equal(calls, 0);
  await h.tick(1); assert.equal(calls, 1);
  h.doc.visibilityState = 'hidden'; await h.event(h.doc, 'visibilitychange');
  await h.tick(120_000); assert.equal(calls, 1);
  h.doc.visibilityState = 'visible'; await h.event(h.doc, 'visibilitychange');
  assert.equal(calls, 2);
  h.controller.stop();
});

test('offline screens wait for reconnection and focus refreshes promptly', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; });
  h.win.navigator.onLine = false; await h.event(h.win, 'offline');
  await h.tick(60_000); assert.equal(calls, 0);
  h.win.navigator.onLine = true; await h.event(h.win, 'online');
  assert.equal(calls, 1);
  await h.event(h.win, 'focus'); assert.equal(calls, 2);
  h.controller.stop();
});

test('manual and focus refreshes share an in-flight request instead of overlapping', async () => {
  let calls = 0, finish;
  const h = harness(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = h.controller.run();
  await h.event(h.win, 'focus');
  const second = h.controller.run();
  assert.equal(calls, 1);
  finish(); await first; await second;
  assert.equal(h.pendingTimers, 1);
  h.controller.stop();
});

test('failed refresh reports the failure and retries at the next interval', async () => {
  let calls = 0;
  const errors = [];
  const failure = new Error('offline during request');
  const h = harness(async () => { if (++calls === 1) throw failure; }, error => errors.push(error));
  await h.controller.run();
  assert.deepEqual(errors, [failure]);
  await h.tick(30_000); assert.equal(calls, 2);
  h.controller.stop();
});

test('stopping during a request prevents new timers or later focus requests', async () => {
  let calls = 0, finish;
  const h = harness(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const pending = h.controller.run(); await Promise.resolve(); h.controller.stop();
  finish(); await pending;
  await h.event(h.win, 'focus'); await h.tick(60_000);
  assert.equal(calls, 1); assert.equal(h.pendingTimers, 0);
});

test('session access comparison distinguishes accounts and permissions without reacting to settings edits', () => {
  assert.equal(typeof module.sessionAccessKey, 'function');
  const session = { configured: true, auth_ready: true, user: { id: 'owner', role: 'admin', status: 'approved' }, settings: { shop_name: 'jinSling' } };
  const key = module.sessionAccessKey(session);
  assert.equal(key, module.sessionAccessKey({ ...session, settings: { shop_name: '새 이름' } }));
  for (const changes of [{ id: 'member' }, { role: 'user' }, { status: 'suspended' }, { needs_password_setup: true }, { password_reset_required: true }]) {
    assert.notEqual(key, module.sessionAccessKey({ ...session, user: { ...session.user, ...changes } }));
  }
  assert.notEqual(key, module.sessionAccessKey({ ...session, user: null }));
});
