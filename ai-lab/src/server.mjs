// A self-contained synthetic-data pilot. This module imports no operational app code.
import { MODEL, IntentError, simulateIntent, inferWorkersIntent } from './intent.mjs';
const COOKIE = '__Host-jinsling_lab_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 4096;
const PROPOSAL_MS = 5 * 60 * 1000;
const IDS = new Set(['owner', 'member_a', 'member_b', 'pending']);
const encoder = new TextEncoder();

class LabError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new LabError(status, code, message); }
function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', ...headers },
  });
}
function errorResponse(error) {
  if (error instanceof IntentError) error = new LabError(503, error.code, error.message);
  if (!(error instanceof LabError)) {
    const message = String(error?.message || '');
    const databaseErrors = [
      ['LAB_STALE_PROPOSAL', 409, 'STALE_PROPOSAL', '확인하는 동안 정보가 바뀌었습니다. 새로 조회하고 다시 제안해 주세요.'],
      ['LAB_PROPOSAL_EXPIRED', 410, 'PROPOSAL_EXPIRED', '확인 유효시간 5분이 지났습니다. 다시 요청해 주세요.'],
      ['LAB_FORBIDDEN', 403, 'FORBIDDEN', '이 계정으로 실행할 수 없는 작업입니다.'],
      ['LAB_MEMBER_NOT_APPROVED', 403, 'MEMBER_NOT_APPROVED', '승인된 실험 회원만 예약할 수 있습니다.'],
      ['LAB_BOOKING_UNAVAILABLE', 409, 'BOOKING_UNAVAILABLE', '다른 예약·잠금 또는 하루 예약 한도 때문에 이 시간을 예약할 수 없습니다.'],
      ['lab_bookings.date, lab_bookings.start_time', 409, 'BOOKING_UNAVAILABLE', '이미 예약된 시간입니다. 다른 시간을 선택해 주세요.'],
      ['LAB_BLOCK_CONFLICT', 409, 'BLOCK_CONFLICT', '이 구간에 예약이 있어 잠글 수 없습니다. 예약은 취소되지 않았습니다.'],
      ['LAB_AI_BUDGET', 429, 'AI_APP_LIMIT', '오늘의 실험 AI 사용 한도(전체 30회·계정별 10회)에 도달했습니다. 일반 예약 도구는 계속 사용할 수 있습니다.'],
    ];
    const match = databaseErrors.find(([marker]) => message.includes(marker));
    if (match) error = new LabError(match[1], match[2], match[3]);
  }
  const known = error instanceof LabError;
  return new Response(JSON.stringify({ ok: false, error: {
    code: known ? error.code : 'LAB_UNAVAILABLE',
    message: known ? error.message : '실험 서버를 사용할 수 없습니다. 잠시 뒤 다시 시도해 주세요.',
  } }), { status: known ? error.status : 503, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
  } });
}

async function guardEnvironment(env) {
  if (env?.LAB_STAGE !== 'sandbox' || !env.LAB_DB?.prepare || !env.LAB_DB?.batch) {
    fail(503, 'LAB_ISOLATION_GUARD', '실험 전용 환경과 DB를 연결해야 합니다.');
  }
  let marker;
  try { marker = await env.LAB_DB.prepare("SELECT value FROM lab_meta WHERE key = 'stage'").first(); }
  catch { fail(503, 'LAB_ISOLATION_GUARD', '이 DB는 실험 전용 DB가 아닙니다. 연결 설정을 확인해 주세요.'); }
  if (marker?.value !== 'sandbox') fail(503, 'LAB_ISOLATION_GUARD', '실험 전용 DB 표식을 확인할 수 없습니다.');
  if (typeof env.LAB_OWNER_CODE !== 'string' || env.LAB_OWNER_CODE.length < 24 ||
      typeof env.LAB_MEMBER_CODE !== 'string' || env.LAB_MEMBER_CODE.length < 24 ||
      env.LAB_OWNER_CODE === env.LAB_MEMBER_CODE) {
    fail(503, 'LAB_CONFIG_INVALID', '서로 다른 24자 이상의 사장님·회원 실험 접속 코드를 설정해야 합니다.');
  }
}

function csrf(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('X-JinSling-Lab') !== '1') {
    fail(403, 'CSRF_REJECTED', '같은 실험 사이트에서 요청해 주세요.');
  }
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    fail(415, 'JSON_REQUIRED', 'JSON 요청이 필요합니다.');
  }
}

async function readJson(request) {
  if (Number(request.headers.get('Content-Length') || 0) > MAX_JSON_BYTES) fail(413, 'REQUEST_TOO_LARGE', '요청이 너무 큽니다.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'INVALID_INPUT', '요청 본문이 필요합니다.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) { await reader.cancel(); fail(413, 'REQUEST_TOO_LARGE', '요청이 너무 큽니다.'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof LabError) throw error;
    fail(400, 'INVALID_INPUT', '올바른 JSON 요청이 필요합니다.');
  } finally { reader.releaseLock(); }
}

function objectFields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    fail(400, 'INVALID_INPUT', '요청 항목을 확인해 주세요.');
  }
}
function publicUser(user) { return { id: user.id, name: user.name, role: user.role, status: user.status }; }
function aiState(env) {
  const mode = env.AI_MODE || 'simulation';
  return { ai_mode: mode, model: MODEL, live_ready: mode === 'workers' && env.FREE_PLAN_CONFIRMED === 'true' && typeof env.AI?.run === 'function' };
}
async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
async function equalSecret(actual, expected) {
  // Hashing normalizes lengths; every comparison examines all 32 digest bytes.
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)), crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < 32; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}
function cookieToken(request) {
  const values = (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(COOKIE.length + 1);
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}
function sessionCookie(token, maxAge) { return `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`; }
async function session(request, env, required = true) {
  const token = cookieToken(request);
  const tokenHash = token ? await digest(token) : null;
  const user = tokenHash ? await env.LAB_DB.prepare(`
    SELECT u.id, u.name, u.role, u.status, u.version
    FROM lab_sessions s JOIN lab_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, Date.now()).first() : null;
  if (!user && required) fail(401, 'LOGIN_REQUIRED', '실험 계정으로 로그인해 주세요.');
  return user ? { ...user, tokenHash } : null;
}
function activeUser(user) {
  if (user.status === 'suspended') fail(403, 'ACCOUNT_SUSPENDED', '이 실험 회원은 이용이 중지되었습니다.');
}

function seoulDate(now = Date.now()) { return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); }
function addDays(date, days) { return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10); }
function validateDate(date, now = Date.now()) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, 'INVALID_DATE', '날짜는 YYYY-MM-DD 형식으로 입력해 주세요.');
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date || date < seoulDate(now) || date > addDays(seoulDate(now), 30)) {
    fail(400, 'INVALID_DATE', '서울 시간 기준 오늘부터 30일 뒤까지 선택할 수 있습니다.');
  }
  return date;
}
function hours(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? { close: 0, cap: 0 } : day === 6 ? { close: 14 * 60, cap: 10 } : { close: 20 * 60, cap: 18 };
}
function clock(minutes) { return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; }
function slotInstant(date, time) { return Date.parse(`${date}T${time}:00+09:00`); }
async function availability(env, date, now = Date.now()) {
  const [bookingResult, blockResult] = await Promise.all([
    env.LAB_DB.prepare("SELECT start_time, end_time FROM lab_bookings WHERE date = ? AND status = 'booked'").bind(date).all(),
    env.LAB_DB.prepare('SELECT start_time, end_time FROM lab_blocks WHERE date = ?').bind(date).all(),
  ]);
  const bookings = bookingResult.results, blocks = blockResult.results;
  const { close, cap } = hours(date);
  const slots = [];
  for (let minutes = 9 * 60; minutes < close; minutes += 30) {
    const start_time = clock(minutes), end_time = clock(minutes + 30);
    const booked = bookings.some(booking => booking.start_time < end_time && booking.end_time > start_time);
    const blocked = blocks.some(block => block.start_time < end_time && block.end_time > start_time);
    const status = booked ? 'booked' : blocked ? 'blocked' : slotInstant(date, start_time) <= now ? 'past' : bookings.length >= cap ? 'capacity' : 'available';
    slots.push({ start_time, end_time, available: status === 'available', status });
  }
  return slots;
}
async function dashboard(env, user, date) {
  const owner = user.role === 'owner';
  const bookingQuery = `SELECT b.id, b.member_id, u.name AS member_name, b.date, b.start_time, b.end_time, b.status, b.version
    FROM lab_bookings b JOIN lab_users u ON u.id = b.member_id WHERE b.date = ? ${owner ? '' : 'AND b.member_id = ?'} ORDER BY b.start_time, b.id`;
  const bookings = await env.LAB_DB.prepare(bookingQuery).bind(...(owner ? [date] : [date, user.id])).all();
  const result = { date, timezone: 'Asia/Seoul', slots: await availability(env, date), bookings: bookings.results };
  if (owner) {
    result.members = (await env.LAB_DB.prepare('SELECT id, name, status FROM lab_users ORDER BY id').all()).results;
    result.blocks = (await env.LAB_DB.prepare('SELECT id, date, period, start_time, end_time, version FROM lab_blocks WHERE date = ? ORDER BY start_time, id').bind(date).all()).results;
  }
  return result;
}

function ownerOnly(user) {
  if (user.role !== 'owner') fail(403, 'FORBIDDEN', '사장님 실험 계정만 사용할 수 있는 기능입니다.');
}
function approvedOnly(user) {
  if (user.status !== 'approved') fail(403, 'MEMBER_NOT_APPROVED', '승인된 실험 회원만 예약을 변경할 수 있습니다.');
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail(400, 'INVALID_INPUT', '대상 식별자를 확인해 주세요.');
  return value;
}
function bookingTimes(date, start, now = Date.now()) {
  validateDate(date, now);
  if (typeof start !== 'string' || !/^\d{2}:(00|30)$/.test(start)) fail(400, 'INVALID_INPUT', '시간은 30분 단위 HH:MM 형식이어야 합니다.');
  const minutes = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
  if (minutes < 9 * 60 || minutes + 30 > hours(date).close || slotInstant(date, start) <= now) {
    fail(400, 'INVALID_INPUT', '예약 가능한 영업시간 중 아직 시작하지 않은 시간을 선택해 주세요.');
  }
  return { start_time: start, end_time: clock(minutes + 30) };
}
const PERIODS = Object.freeze({ day: ['00:00', '24:00'], morning: ['00:00', '12:00'], afternoon: ['12:00', '24:00'] });

async function validateAction(env, user, action, input, now = Date.now()) {
  approvedOnly(user);
  const expected = { actor_version: user.version };
  if (action === 'book') {
    objectFields(input, ['date', 'start_time', 'member_id'], ['date', 'start_time']);
    const date = validateDate(input.date, now), times = bookingTimes(date, input.start_time, now);
    const memberId = input.member_id ?? user.id;
    if (user.role !== 'owner' && memberId !== user.id) fail(403, 'FORBIDDEN', '자신의 예약만 요청할 수 있습니다.');
    identifier(memberId);
    const member = await env.LAB_DB.prepare('SELECT id, name, role, status, version FROM lab_users WHERE id = ?').bind(memberId).first();
    if (!member || member.role !== 'member') fail(400, 'INVALID_INPUT', '예약할 가상 회원을 선택해 주세요.');
    if (member.status !== 'approved') fail(403, 'MEMBER_NOT_APPROVED', '승인된 실험 회원만 예약할 수 있습니다.');
    const available = (await availability(env, date, now)).find(slot => slot.start_time === times.start_time);
    if (!available?.available) fail(409, 'BOOKING_UNAVAILABLE', '다른 예약·잠금 또는 하루 예약 한도 때문에 이 시간을 예약할 수 없습니다.');
    expected.member_version = member.version;
    return { action, data: { date, start_time: times.start_time, member_id: member.id },
      details: { date, ...times, member_id: member.id, member_name: member.name }, expected,
      summary: `${member.name} · ${date} ${times.start_time}–${times.end_time} 예약` };
  }
  if (action === 'cancel') {
    objectFields(input, ['booking_id']);
    const id = identifier(input.booking_id);
    const booking = await env.LAB_DB.prepare(`SELECT b.id, b.member_id, u.name AS member_name, b.date, b.start_time, b.end_time, b.status, b.version
      FROM lab_bookings b JOIN lab_users u ON u.id = b.member_id WHERE b.id = ? ${user.role === 'owner' ? '' : 'AND b.member_id = ?'}`)
      .bind(...(user.role === 'owner' ? [id] : [id, user.id])).first();
    if (!booking) fail(404, 'BOOKING_NOT_FOUND', '변경할 예약을 찾을 수 없습니다.');
    if (booking.status !== 'booked' || slotInstant(booking.date, booking.start_time) <= now) fail(409, 'STALE_PROPOSAL', '이미 취소되었거나 시작된 예약입니다. 예약 목록을 다시 확인해 주세요.');
    expected.booking_version = booking.version;
    return { action, data: { booking_id: id }, details: { ...booking }, expected,
      summary: `${booking.member_name} · ${booking.date} ${booking.start_time} 예약 취소` };
  }
  if (action === 'block') {
    ownerOnly(user);
    objectFields(input, ['date', 'period']);
    const date = validateDate(input.date, now);
    if (typeof input.period !== 'string' || !Object.hasOwn(PERIODS, input.period)) fail(400, 'INVALID_INPUT', '하루·오전·오후 중 하나를 선택해 주세요.');
    const [start_time, end_time] = PERIODS[input.period];
    const overlap = await env.LAB_DB.prepare("SELECT id FROM lab_bookings WHERE date = ? AND status = 'booked' AND start_time < ? AND end_time > ? LIMIT 1")
      .bind(date, end_time, start_time).first();
    if (overlap) fail(409, 'BLOCK_CONFLICT', '이 구간에 예약이 있어 잠글 수 없습니다. 예약은 취소되지 않았습니다.');
    return { action, data: { date, period: input.period }, details: { date, period: input.period, start_time, end_time }, expected,
      summary: `${date} ${start_time}–${end_time} 예약 잠금` };
  }
  if (action === 'unblock') {
    ownerOnly(user);
    objectFields(input, ['block_id']);
    const id = identifier(input.block_id);
    const block = await env.LAB_DB.prepare('SELECT id, date, period, start_time, end_time, version FROM lab_blocks WHERE id = ?').bind(id).first();
    if (!block) fail(404, 'BLOCK_NOT_FOUND', '해제할 잠금을 찾을 수 없습니다.');
    expected.block_version = block.version;
    return { action, data: { block_id: id }, details: { ...block }, expected,
      summary: `${block.date} ${block.start_time}–${block.end_time} 잠금 해제` };
  }
  if (action === 'member_status') {
    ownerOnly(user);
    objectFields(input, ['member_id', 'status']);
    const id = identifier(input.member_id);
    if (!['approved', 'suspended'].includes(input.status) || id === 'owner') fail(400, 'INVALID_INPUT', '가상 회원과 승인·중지 상태를 선택해 주세요.');
    const member = await env.LAB_DB.prepare("SELECT id, name, status, version FROM lab_users WHERE id = ? AND role = 'member'").bind(id).first();
    if (!member) fail(404, 'MEMBER_NOT_FOUND', '가상 회원을 찾을 수 없습니다.');
    if (member.status === input.status) fail(409, 'NO_CHANGE', '이미 해당 상태인 회원입니다.');
    expected.member_version = member.version;
    return { action, data: { member_id: id, status: input.status },
      details: { member_id: id, member_name: member.name, from_status: member.status, status: input.status }, expected,
      summary: `${member.name} · ${input.status === 'approved' ? '이용 승인' : '이용 중지'} (기존 예약은 유지)` };
  }
  fail(400, 'INVALID_INPUT', '지원하지 않는 작업입니다.');
}

async function createProposal(env, user, action, input) {
  const now = Date.now();
  const validated = await validateAction(env, user, action, input, now);
  const id = crypto.randomUUID(), expires = now + PROPOSAL_MS;
  await env.LAB_DB.prepare(`INSERT INTO lab_proposals
    (id, actor_id, action, data_json, expected_json, summary, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, user.id, action, JSON.stringify(validated.data), JSON.stringify(validated.expected), validated.summary, now, expires).run();
  return { id, action, summary: validated.summary, details: validated.details, expires_at: new Date(expires).toISOString() };
}

async function confirmProposal(env, user, id) {
  identifier(id);
  try { return await executeProposal(env, user, id); }
  catch (error) {
    // Another request can commit after our initial read but before a precheck.
    // A committed result takes precedence over an obsolete precheck, including an already deleted block.
    if (error instanceof LabError && ([400, 409, 410].includes(error.status) || error.code === 'BLOCK_NOT_FOUND')) {
      const finished = await env.LAB_DB.prepare('SELECT action, state, result_json FROM lab_proposals WHERE id = ? AND actor_id = ?').bind(id, user.id).first();
      if (finished?.state === 'confirmed') return { replayed: true, action: finished.action, result: JSON.parse(finished.result_json), message: '이미 처리한 요청입니다. 같은 변경을 다시 실행하지 않았습니다.' };
    }
    throw error;
  }
}

async function executeProposal(env, user, id) {
  const stored = await env.LAB_DB.prepare('SELECT * FROM lab_proposals WHERE id = ? AND actor_id = ?').bind(id, user.id).first();
  if (!stored) fail(404, 'PROPOSAL_NOT_FOUND', '이 계정의 확인 요청을 찾을 수 없습니다.');
  if (stored.state === 'confirmed') return { replayed: true, action: stored.action, result: JSON.parse(stored.result_json), message: '이미 처리한 요청입니다. 같은 변경을 다시 실행하지 않았습니다.' };
  if (stored.expires_at <= Date.now()) fail(410, 'PROPOSAL_EXPIRED', '확인 유효시간 5분이 지났습니다. 다시 요청해 주세요.');
  const originalExpected = JSON.parse(stored.expected_json);
  if (originalExpected.actor_version !== user.version) fail(409, 'STALE_PROPOSAL', '계정 상태가 변경되었습니다. 새로 요청해 주세요.');
  const validated = await validateAction(env, user, stored.action, JSON.parse(stored.data_json));
  if (Object.keys(originalExpected).length !== Object.keys(validated.expected).length ||
      Object.entries(originalExpected).some(([key, value]) => validated.expected[key] !== value)) {
    fail(409, 'STALE_PROPOSAL', '대상 정보가 변경되었습니다. 새로 조회하고 다시 요청해 주세요.');
  }
  const execution = crypto.randomUUID(), now = Date.now();
  const claim = 'EXISTS (SELECT 1 FROM lab_proposals WHERE id = ? AND execution_id = ? AND state = \'executing\')';
  const statements = [env.LAB_DB.prepare(`UPDATE lab_proposals SET state = 'executing', execution_id = ?, confirmed_at = ?
    WHERE id = ? AND actor_id = ? AND state = 'pending' AND expires_at > ?
      AND EXISTS (SELECT 1 FROM lab_sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?)`)
    .bind(execution, now, id, user.id, now, user.tokenHash, user.id, now)];
  let result;
  const d = validated.details;
  if (stored.action === 'book') {
    const booking = { id: crypto.randomUUID(), ...d, status: 'booked', version: 1 };
    statements.push(env.LAB_DB.prepare(`INSERT INTO lab_bookings
      (id, member_id, date, start_time, end_time, status, version, created_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, 'booked', 1, ?, ?, ? WHERE ${claim}`)
      .bind(booking.id, d.member_id, d.date, d.start_time, d.end_time, user.id, now, now, id, execution));
    result = { booking };
  } else if (stored.action === 'cancel') {
    statements.push(env.LAB_DB.prepare(`UPDATE lab_bookings SET status = 'cancelled', version = version + 1, updated_at = ? WHERE id = ? AND ${claim}`)
      .bind(now, d.id, id, execution));
    result = { booking: { ...d, status: 'cancelled', version: d.version + 1 } };
  } else if (stored.action === 'block') {
    const block = { id: crypto.randomUUID(), ...d, version: 1 };
    statements.push(env.LAB_DB.prepare(`INSERT INTO lab_blocks (id, date, period, start_time, end_time, version, created_by, created_at)
      SELECT ?, ?, ?, ?, ?, 1, ?, ? WHERE ${claim}`)
      .bind(block.id, d.date, d.period, d.start_time, d.end_time, user.id, now, id, execution));
    result = { block };
  } else if (stored.action === 'unblock') {
    statements.push(env.LAB_DB.prepare(`DELETE FROM lab_blocks WHERE id = ? AND ${claim}`).bind(d.id, id, execution));
    result = { block_id: d.id, removed: true };
  } else if (stored.action === 'member_status') {
    statements.push(env.LAB_DB.prepare(`UPDATE lab_users SET status = ?, version = version + 1 WHERE id = ? AND ${claim}`)
      .bind(d.status, d.member_id, id, execution));
    result = { member: { id: d.member_id, name: d.member_name, status: d.status } };
  }
  statements.push(env.LAB_DB.prepare(`INSERT INTO lab_audit (proposal_id, actor_id, action, details_json, created_at)
    SELECT ?, ?, ?, ?, ? WHERE ${claim}`).bind(id, user.id, stored.action, JSON.stringify(validated.data), now, id, execution));
  statements.push(env.LAB_DB.prepare("UPDATE lab_proposals SET state = 'confirmed', result_json = ? WHERE id = ? AND execution_id = ? AND state = 'executing'")
    .bind(JSON.stringify(result), id, execution));
  const committed = await env.LAB_DB.batch(statements);
  const finished = await env.LAB_DB.prepare('SELECT action, state, result_json, expires_at FROM lab_proposals WHERE id = ? AND actor_id = ?').bind(id, user.id).first();
  if (finished?.state !== 'confirmed') {
    if (finished?.expires_at <= Date.now()) fail(410, 'PROPOSAL_EXPIRED', '확인 유효시간이 지났습니다. 다시 요청해 주세요.');
    fail(401, 'LOGIN_REQUIRED', '로그인 세션을 다시 확인해 주세요.');
  }
  const replayed = committed[0].meta.changes === 0;
  return { replayed, action: finished.action, result: JSON.parse(finished.result_json),
    message: replayed ? '이미 처리한 요청입니다. 같은 변경을 다시 실행하지 않았습니다.' : '확인한 변경을 실험 DB에 저장했습니다.' };
}

async function reserveAiBudget(env, user) {
  const day = new Date(Date.now()).toISOString().slice(0, 10); // Same UTC reset as Workers AI.
  const reserve = id => env.LAB_DB.prepare(`INSERT INTO lab_ai_usage (day, user_id, used) VALUES (?, ?, 1)
    ON CONFLICT (day, user_id) DO UPDATE SET used = used + 1`).bind(day, id);
  // If the second counter is full, D1 rolls back both increments. Failed provider calls still count.
  await env.LAB_DB.batch([reserve('*'), reserve(user.id)]);
}

async function readBookings(env, user, date = null, all = false) {
  if (all) ownerOnly(user);
  if (date) validateDate(date);
  const start = date || seoulDate(), end = date || addDays(seoulDate(), 30);
  const values = all ? [start, end] : [start, end, user.id];
  return (await env.LAB_DB.prepare(`SELECT b.id, b.member_id, u.name AS member_name, b.date, b.start_time, b.end_time, b.status, b.version
    FROM lab_bookings b JOIN lab_users u ON u.id = b.member_id
    WHERE b.date >= ? AND b.date <= ? AND b.status = 'booked' ${all ? '' : 'AND b.member_id = ?'} ORDER BY b.date, b.start_time`)
    .bind(...values).all()).results;
}

async function handleChat(request, env, user, message) {
  const mode = env.AI_MODE || 'simulation';
  let parsed;
  if (mode === 'simulation') parsed = simulateIntent(message);
  else if (mode === 'workers') {
    if (env.FREE_PLAN_CONFIRMED !== 'true' || typeof env.AI?.run !== 'function') {
      fail(503, 'AI_NOT_CONFIGURED', '실제 AI는 Workers Free 확인과 실험 전용 AI 연결 후 사용할 수 있습니다. 일반 예약 도구를 이용해 주세요.');
    }
    await reserveAiBudget(env, user);
    parsed = await inferWorkersIntent(env.AI, message);
  } else fail(503, 'AI_NOT_CONFIGURED', 'AI 모드 설정을 확인해 주세요.');
  // An inference can take seconds: refresh authentication before revealing data or proposing work.
  user = await session(request, env);
  activeUser(user);
  const reply = (text, extra = {}) => ({ ai_mode: mode, message: `${mode === 'simulation' ? '[모의 대화] ' : ''}${text}`, ...extra });
  if (parsed.intent === 'clarify') return reply('요청을 하나씩 구체적으로 입력해 주세요. 예: “내일 빈 시간”, “내일 10:00 예약”, “내 예약 보여줘”. 정확한 날짜·시간을 확인한 뒤 제안합니다.');
  if (parsed.intent === 'availability') {
    const date = validateDate(parsed.date || seoulDate());
    return reply(`${date} 예약 가능한 시간입니다. 실제 예약은 제안 내용을 확인한 뒤 저장됩니다.`, { view: { type: 'availability', date, slots: await availability(env, date) } });
  }
  if (parsed.intent === 'my_bookings') {
    const items = await readBookings(env, user, parsed.date);
    return reply(parsed.date ? `${parsed.date}의 내 예약입니다.` : '오늘부터 30일 뒤까지의 내 예약입니다.', { view: { type: 'bookings', ...(parsed.date ? { date: parsed.date } : {}), items } });
  }
  if (parsed.intent === 'schedule') {
    ownerOnly(user);
    const date = validateDate(parsed.date || seoulDate());
    const data = await dashboard(env, user, date);
    return reply(`${date} 전체 일정입니다.`, { view: { type: 'schedule', date, items: data.bookings, slots: data.slots } });
  }
  if (parsed.intent === 'members') {
    ownerOnly(user);
    const items = (await env.LAB_DB.prepare('SELECT id, name, status FROM lab_users ORDER BY id').all()).results;
    return reply('실험용 가상 회원 목록입니다.', { view: { type: 'members', items } });
  }
  if (['block', 'unblock', 'member_status'].includes(parsed.intent)) ownerOnly(user);
  if (parsed.intent === 'book' && (!parsed.date || !parsed.start_time || (user.role === 'owner' && !parsed.member_id))) {
    return reply('예약할 날짜와 시간을 구체적으로 입력해 주세요. 사장님 예약은 가상 회원 ID(member_a, member_b, pending)도 선택해야 합니다.');
  }
  if (parsed.intent === 'cancel' && !parsed.booking_id) {
    return reply('취소할 예약을 목록에서 선택해 주세요. 예약을 자동으로 고르거나 취소하지 않았습니다.', {
      view: { type: 'bookings', ...(parsed.date ? { date: parsed.date } : {}), items: await readBookings(env, user, parsed.date, user.role === 'owner') },
    });
  }
  if (parsed.intent === 'block' && (!parsed.date || !parsed.period)) return reply('잠글 날짜와 하루·오전·오후 중 하나를 구체적으로 선택해 주세요.');
  if (parsed.intent === 'unblock' && !parsed.block_id) {
    const date = validateDate(parsed.date || seoulDate());
    const items = (await env.LAB_DB.prepare('SELECT id, date, period, start_time, end_time, version FROM lab_blocks WHERE date = ? ORDER BY start_time').bind(date).all()).results;
    return reply('해제할 잠금을 선택해 주세요. 다른 잠금은 유지됩니다.', { view: { type: 'blocks', date, items } });
  }
  if (parsed.intent === 'member_status' && (!parsed.member_id || !parsed.status)) return reply('변경할 가상 회원 ID와 승인·중지 상태를 구체적으로 선택해 주세요.');
  const actions = {
    book: () => ({ date: parsed.date, start_time: parsed.start_time, ...(parsed.member_id ? { member_id: parsed.member_id } : {}) }),
    cancel: () => ({ booking_id: parsed.booking_id }),
    block: () => ({ date: parsed.date, period: parsed.period }),
    unblock: () => ({ block_id: parsed.block_id }),
    member_status: () => ({ member_id: parsed.member_id, status: parsed.status }),
  };
  const proposal = await createProposal(env, user, parsed.intent, actions[parsed.intent]());
  return reply('아직 변경하지 않았습니다. 아래 내용을 확인하고 5분 이내에 확인 버튼을 눌러 주세요.', { proposal });
}

export async function handleLab(request, env) {
  try {
    await guardEnvironment(env);
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청 방식입니다.');
    let body;
    if (request.method === 'POST') { csrf(request); body = await readJson(request); }
    if (url.pathname === '/api/session' && request.method === 'GET') {
      const user = await session(request, env, false);
      return response({ user: user ? publicUser(user) : null, ...aiState(env) });
    }
    if (url.pathname === '/api/login' && request.method === 'POST') {
      objectFields(body, ['account', 'access_code']);
      if (typeof body.account !== 'string' || typeof body.access_code !== 'string' || body.access_code.length > 256) fail(400, 'INVALID_INPUT', '계정과 접속 코드를 확인해 주세요.');
      const matches = await equalSecret(body.access_code, body.account === 'owner' ? env.LAB_OWNER_CODE : env.LAB_MEMBER_CODE);
      if (!IDS.has(body.account) || !matches) fail(401, 'INVALID_CREDENTIALS', '실험 계정 또는 접속 코드가 맞지 않습니다.');
      const user = await env.LAB_DB.prepare('SELECT id, name, role, status, version FROM lab_users WHERE id = ?').bind(body.account).first();
      if (!user) fail(401, 'INVALID_CREDENTIALS', '실험 계정 또는 접속 코드가 맞지 않습니다.');
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
      const now = Date.now();
      await env.LAB_DB.prepare('INSERT INTO lab_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await digest(token), user.id, now, now + SESSION_MS).run();
      return response({ user: publicUser(user), ...aiState(env) }, 200, { 'Set-Cookie': sessionCookie(token, SESSION_MS / 1000) });
    }
    if (url.pathname === '/api/logout' && request.method === 'POST') {
      objectFields(body, []);
      const token = cookieToken(request);
      if (token) await env.LAB_DB.prepare('DELETE FROM lab_sessions WHERE token_hash = ?').bind(await digest(token)).run();
      return response({ logged_out: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
    }
    const user = await session(request, env);
    activeUser(user);
    if (url.pathname === '/api/dashboard' && request.method === 'GET') {
      return response(await dashboard(env, user, validateDate(url.searchParams.get('date') || seoulDate())));
    }
    if (url.pathname === '/api/propose' && request.method === 'POST') {
      objectFields(body, ['action', 'data']);
      return response({ proposal: await createProposal(env, user, body.action, body.data) });
    }
    if (url.pathname === '/api/confirm' && request.method === 'POST') {
      objectFields(body, ['proposal_id']);
      return response(await confirmProposal(env, user, body.proposal_id));
    }
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      objectFields(body, ['message']);
      if (typeof body.message !== 'string' || !body.message.trim() || Array.from(body.message).length > 512) {
        fail(400, 'INVALID_INPUT', '메시지는 1자 이상 512자 이내로 입력해 주세요.');
      }
      return response(await handleChat(request, env, user, body.message));
    }
    fail(404, 'NOT_FOUND', '요청한 실험 기능을 찾을 수 없습니다.');
  } catch (error) { return errorResponse(error); }
}
