import assert from 'node:assert/strict';
import { createLabDatabase } from './sqlite-d1.mjs';
import { handleLab } from '../src/server.mjs';

export const OWNER_CODE = 'lab-owner-test-secret-at-least-24-characters';
export const MEMBER_CODE = 'lab-member-test-secret-at-least-24-characters';
export const NOW = Date.parse('2026-11-09T00:00:00Z'); // Monday, 09:00 in Seoul.

export function fixture(t, overrides = {}, timerApis = ['Date']) {
  t.mock.timers.enable({ apis: timerApis, now: NOW });
  const db = createLabDatabase();
  t.after(() => db.close());
  const env = {
    LAB_DB: db.binding, LAB_STAGE: 'sandbox', LAB_OWNER_CODE: OWNER_CODE,
    LAB_MEMBER_CODE: MEMBER_CODE, AI_MODE: 'simulation', ...overrides,
  };
  async function call(path, { method = 'GET', body, cookie, headers = {}, csrf = true, origin = 'https://lab.example' } = {}) {
    const finalHeaders = new Headers(headers);
    if (method !== 'GET') {
      if (!finalHeaders.has('Content-Type')) finalHeaders.set('Content-Type', 'application/json');
      if (csrf) finalHeaders.set('X-JinSling-Lab', '1');
      if (origin !== null) finalHeaders.set('Origin', origin);
    }
    if (cookie) finalHeaders.set('Cookie', cookie);
    const response = await handleLab(new Request(`https://lab.example${path}`, {
      method, headers: finalHeaders, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }), env);
    const json = await response.json();
    return { response, json, data: json.data, error: json.error, status: response.status };
  }
  async function login(account = 'member_a') {
    const result = await call('/api/login', { method: 'POST', body: { account, access_code: account === 'owner' ? OWNER_CODE : MEMBER_CODE } });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(result.json.ok, true);
    return { ...result, cookie: result.response.headers.get('Set-Cookie').split(';')[0] };
  }
  return { ...db, env, call, login };
}

export async function proposal(f, cookie, action, data) {
  const result = await f.call('/api/propose', { method: 'POST', cookie, body: { action, data } });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.data.proposal;
}

export async function confirm(f, cookie, id) {
  return f.call('/api/confirm', { method: 'POST', cookie, body: { proposal_id: id } });
}

export async function book(f, cookie, data) {
  const p = await proposal(f, cookie, 'book', data);
  const result = await confirm(f, cookie, p.id);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.data.result.booking;
}

export function providerResponse(content, overrides = {}) {
  return {
    id: 'example-completion', object: 'chat.completion', created: 1794182400,
    model: '@cf/google/gemma-4-26b-a4b-it',
    choices: [{ index: 0, message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content), refusal: null }, finish_reason: 'stop', logprobs: null }],
    usage: { prompt_tokens: 90, completion_tokens: 30, total_tokens: 120 }, ...overrides,
  };
}

export function intent(fields) {
  return { intent: 'clarify', date: null, start_time: null, member_id: null, booking_id: null, block_id: null, period: null, status: null, ...fields };
}
